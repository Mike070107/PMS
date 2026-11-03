import { useEffect, useRef } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import ImageExtension from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Icon from '@/components/Icon';
import { toast } from '@/components/ui';
import { uploadImage } from '@/lib/upload';

/**
 * 维修经验富文本编辑器（笔记软件式）。
 *
 * 用 TipTap（和旧后台同一套引擎），产出的 HTML 标签正好落在服务端
 * cleanDocumentHtml 的白名单里（strong/em/s、h2/h3、ul/ol/li、任务清单的
 * label+input、blockquote、hr、figure/img、a）。保存成单个 type:'document' 块。
 * 所有加图片的地方都支持直接粘贴（截图即贴），和 PhotoField 一致。
 */
export default function RichNoteEditor({
  html,
  onChange,
}: {
  html: string;
  onChange: (html: string) => void;
}) {
  const editorRef = useRef<Editor | null>(null);
  const busyRef = useRef(false);

  const insertImageFiles = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length || busyRef.current) return;
    busyRef.current = true;
    try {
      for (const f of imgs) {
        const url = await uploadImage(f);
        editorRef.current?.chain().focus().setImage({ src: url }).run();
      }
      toast(`已插入 ${imgs.length} 张图片`);
    } catch {
      toast('图片上传失败');
    } finally {
      busyRef.current = false;
    }
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      ImageExtension.configure({ allowBase64: false }),
      Placeholder.configure({ placeholder: '写下维修经验，或用上方工具加标题、清单、图片…可直接粘贴截图' }),
    ],
    content: html || '<p></p>',
    onUpdate: ({ editor: cur }) => onChange(cur.getHTML()),
    editorProps: {
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files || [])];
        if (files.some((f) => f.type.startsWith('image/'))) {
          event.preventDefault();
          void insertImageFiles(files);
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = [...((event as DragEvent).dataTransfer?.files || [])];
        if (files.some((f) => f.type.startsWith('image/'))) {
          event.preventDefault();
          void insertImageFiles(files);
          return true;
        }
        return false;
      },
    },
  });

  useEffect(() => { editorRef.current = editor; }, [editor]);

  if (!editor) return <div className="rich-editor-loading muted">编辑器加载中…</div>;

  const pickImage = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = () => { if (input.files) void insertImageFiles([...input.files]); };
    input.click();
  };

  const Btn = ({ on, title, onClick, children }: { on?: boolean; title: string; onClick: () => void; children: React.ReactNode }) => (
    <button type="button" className={`re-btn ${on ? 'on' : ''}`} title={title}
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}>{children}</button>
  );

  return (
    <div className="rich-editor">
      <div className="re-toolbar">
        <Btn title="撤销" onClick={() => editor.chain().focus().undo().run()}><Icon name="refresh" size={15} style={{ transform: 'scaleX(-1)' }} /></Btn>
        <Btn title="重做" onClick={() => editor.chain().focus().redo().run()}><Icon name="refresh" size={15} /></Btn>
        <span className="re-sep" />
        <Btn title="大标题" on={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><b>H1</b></Btn>
        <Btn title="小标题" on={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><b>H2</b></Btn>
        <Btn title="加粗" on={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></Btn>
        <Btn title="斜体" on={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></Btn>
        <Btn title="删除线" on={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></Btn>
        <span className="re-sep" />
        <Btn title="无序列表" on={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>• 列表</Btn>
        <Btn title="有序列表" on={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1. 列表</Btn>
        <Btn title="任务清单" on={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()}>☑ 清单</Btn>
        <Btn title="引用" on={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>❝ 引用</Btn>
        <Btn title="代码块" on={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>{'</>'}</Btn>
        <Btn title="分隔线" onClick={() => editor.chain().focus().setHorizontalRule().run()}>—</Btn>
        <span className="re-sep" />
        <Btn title="插入图片" onClick={pickImage}><Icon name="image" size={15} />图片</Btn>
      </div>
      <EditorContent editor={editor} className="re-content" />
    </div>
  );
}
