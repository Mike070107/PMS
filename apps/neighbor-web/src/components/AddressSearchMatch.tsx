import { tokenizeAddress } from '@pms/shared-types';

interface Props {
  address: string;
  query: string;
  phone?: string | null;
  plate?: string;
  owner?: string | null;
}

function highlight(value: string, terms: string[]) {
  const source = value.toUpperCase();
  const matched = Array<boolean>(value.length).fill(false);
  for (const term of terms.filter(Boolean)) {
    const needle = term.toUpperCase();
    for (let i = source.indexOf(needle); i >= 0; i = source.indexOf(needle, i + needle.length)) {
      matched.fill(true, i, i + needle.length);
    }
  }
  const parts = [];
  for (let start = 0; start < value.length;) {
    let end = start + 1;
    while (end < value.length && matched[end] === matched[start]) end++;
    const part = value.slice(start, end);
    parts.push(matched[start] ? <mark key={start}>{part}</mark> : part);
    start = end;
  }
  return parts;
}

export default function AddressSearchMatch({ address, query, phone, plate, owner }: Props) {
  const term = query.trim();
  const digits = /^\d+$/.test(term) ? term : '';
  const number = (phone || '').split(/[\s,，、;/]+/).find(p => digits && p.includes(digits));
  const detail = plate || number || (owner?.includes(term) ? owner : '');
  return <span className="address-search-match">
    <span>{highlight(address, [term, ...tokenizeAddress(term)])}</span>
    {detail && <span className="address-search-detail">{highlight(detail, [term])}</span>}
  </span>;
}
