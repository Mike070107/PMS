const labelMap = {
  created: '待派单',
  dispatched: '已派单',
  in_progress: '维修中',
  waiting_material: '等待材料',
  done_pending_review: '待验收',
  completed: '已完成',
  cancelled: '已撤单',
};
const colorMap = {
  created: '#faad14',
  dispatched: '#1677ff',
  in_progress: '#1677ff',
  waiting_material: '#faad14',
  done_pending_review: '#722ed1',
  completed: '#52c41a',
  cancelled: '#8c8c8c',
};

Component({
  properties: {
    status: { type: String, value: 'created' },
  },
  data: { label: '', color: '' },
  observers: {
    status(v) {
      this.setData({ label: labelMap[v] || v, color: colorMap[v] || '#8c8c8c' });
    },
  },
});
