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
    /** created 状态可按分流结果覆盖成“待接单”；不传保持原有标签 */
    label: { type: String, value: '' },
  },
  data: { text: '', color: '' },
  observers: {
    'status,label'(status, label) {
      this.setData({
        text: label || labelMap[status] || status,
        // CREATED 已经匹配到工种时是「等维修工确认」，用处理中的蓝色；
        // 真正等办公室派单才保留黄色提醒。
        color: label === '待接单' ? '#1677ff' : colorMap[status] || '#8c8c8c',
      });
    },
  },
});
