import { useEffect, useRef, useState } from 'react';
import { addressSearchKey, type AddressCommunity } from '@pms/shared-types';
import HouseAddressPicker, { type PickedAddress } from '@/components/HouseAddressPicker';

/** List filtering is text-first; address selection uses the same production Cascader. */
export default function AddressSearch({ communities, value, onChange, placeholder, width = 360, live = true, onTextChange }: {
  communities: AddressCommunity[];
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
  width?: number;
  live?: boolean;
  onTextChange?: (text: string) => void;
}) {
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(true);
  const [path, setPath] = useState<Array<number | string>>([]);
  const last = useRef(value);
  const timer = useRef<number | undefined>(undefined);
  const cancel = () => { window.clearTimeout(timer.current); timer.current = undefined; };
  useEffect(() => {
    if (value !== last.current) { cancel(); last.current = value; setText(value); setPath([]); setEditing(true); }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const emit = (next: string, force = false) => {
    cancel();
    const trimmed = next.trim();
    if (!force && trimmed === last.current) return;
    last.current = trimmed;
    onChange(trimmed);
  };
  useEffect(() => {
    if (!live) return undefined;
    timer.current = window.setTimeout(() => emit(text), 400);
    return cancel;
  }, [text, live]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (picked: PickedAddress | null) => {
    const community = communities.find(c => c.id === picked?.communityId);
    const building = community?.buildings.find(b => b.id === picked?.buildingId);
    if (picked && !community) return;
    const next = community ? addressSearchKey(community, building, picked?.roomNo) : '';
    setEditing(false); setText(next); onTextChange?.(next); emit(next, true);
    if (!picked) setPath([]);
  };
  return <div className="addr-search" style={{ width, maxWidth: '100%' }}>
    <HouseAddressPicker communities={communities} value={path} onChange={setPath}
      searchText={editing ? text : ''} displayText={text} selectionLevel="all" showCopy={false}
      placeholder={placeholder ?? '198/20、一期20号601、电话、单号…'}
      onSearchText={next => { setEditing(true); cancel(); setText(next); setPath([]); onTextChange?.(next); }}
      onSubmitText={() => emit(text, true)} onPicked={pick} />
  </div>;
}
