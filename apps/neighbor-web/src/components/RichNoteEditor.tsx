import { ExperienceDocumentEditor, type ExperienceEditorProps } from '@legacy/pages/ExperienceNotesPage';

/** The existing editor entry reuses the same TipTap engine and protected image paths. */
export default function RichNoteEditor(props: ExperienceEditorProps) {
  return <ExperienceDocumentEditor {...props} />;
}
