import type { ReactNode } from 'react';

/** 本期还没重做完成的页面：如实说明现状，并给一条回到现有功能的入口 */
export function Placeholder({ title, desc, legacy, children }: {
  title: string;
  desc: string;
  legacy?: string;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="ph"><div><h1>{title}</h1><p>{desc}</p></div></div>
      <div className="card" style={{ padding: 22 }}>
        <div className="sec-t">这一页还在迁移中</div>
        <p className="sub" style={{ fontSize: 13.5, lineHeight: 1.8, margin: '0 0 14px' }}>
          新版界面先做了外壳和工单调度，这一页的功能仍然在现有后台里，点下面的按钮直接过去，数据和账号是同一套。
        </p>
        {legacy ? <button className="btn p" onClick={() => { window.location.href = legacy; }}>打开现有页面</button> : null}
        {children}
      </div>
    </>
  );
}
