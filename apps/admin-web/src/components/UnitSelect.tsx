import { Select } from 'antd';
import { useMemo, useState } from 'react';
import { buildUnitOptions, isCommonUnit } from '../lib/materialUnits';

/**
 * 材料单位下拉：常用单位分组直选，也允许敲一个表里没有的单位。
 * 原来这里是纯输入框，改成严格下拉会让"卷尺/延米"这类特殊单位没法填，所以保留自定义。
 */
export default function UnitSelect({
  value,
  onChange,
  usedUnits = [],
  placeholder = '选择或输入',
  id,
}: {
  value?: string;
  onChange?: (value: string) => void;
  /** 库里已经在用的单位，保证老数据的单位不会消失 */
  usedUnits?: string[];
  placeholder?: string;
  id?: string;
}) {
  const [search, setSearch] = useState('');

  const options = useMemo(() => {
    const groups = buildUnitOptions(usedUnits, value);
    const keyword = search.trim();
    // 敲了个表里没有的单位，就把它作为一条候选放最前面，回车即可选中
    if (
      keyword &&
      !isCommonUnit(keyword) &&
      !groups.some((group) => group.options.some((option) => option.value === keyword))
    ) {
      return [
        { label: '自定义单位', options: [{ value: keyword, label: keyword }] },
        ...groups,
      ];
    }
    return groups;
  }, [usedUnits, value, search]);

  return (
    <Select
      id={id}
      value={value || undefined}
      placeholder={placeholder}
      showSearch
      allowClear
      searchValue={search}
      onSearch={setSearch}
      onBlur={() => setSearch('')}
      onChange={(next) => {
        setSearch('');
        onChange?.(next);
      }}
      // 分组选项下 option 是叶子项，用 label 匹配即可
      filterOption={(input, option) => String(option?.label ?? '').includes(input.trim())}
      popupMatchSelectWidth={false}
      dropdownStyle={{ minWidth: 240 }}
      options={options}
    />
  );
}
