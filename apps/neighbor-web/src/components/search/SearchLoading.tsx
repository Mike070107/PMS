const assetBase = (import.meta.env?.BASE_URL || '/') + 'search/';

export default function SearchLoading() {
  return <div role="status" style={{display:'grid', justifyItems:'center', padding:'8px 12px 14px', color:'var(--ink2)'}}>
    <picture>
      <source media="(prefers-reduced-motion: reduce)" srcSet={assetBase + 'open-book.png'} />
      <img src={assetBase + 'flipping-book.gif'} alt="" width={200} height={109} style={{display:'block', maxWidth:'100%', height:'auto'}} />
    </picture>
    <span>正在查询…</span>
  </div>;
}
