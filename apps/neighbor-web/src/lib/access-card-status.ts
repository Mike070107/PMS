/**
 * 门禁发卡状态的显示文案 —— 和旧后台「门禁发卡」页同一套口径。
 * 后端存的是英文枚举，直接显示在界面上没法看，这里统一翻成中文并给出配色。
 */

/** 门禁授权状态（这一张卡有没有真正下发到楼栋门禁控制器） */
export function accessStatusLabel(v?: string | null): { text: string; tone: string } {
  switch (v) {
    case 'not_required': return { text: '不适用', tone: 'mute' };
    case 'controller_uploaded': return { text: '已下发', tone: 'ok' };
    case 'not_uploaded': return { text: '未上传', tone: 'dang' };
    case 'access_db_written': return { text: '.88 门禁库已写入，控制器待确认', tone: 'mute' };
    case 'permission_check_pending': return { text: '权限核验中', tone: 'mute' };
    case 'permission_check_failed': return { text: '权限核验失败', tone: 'dang' };
    case 'waiting_retry': return { text: '下载失败 · 门禁控制器离线', tone: 'dang' };
    case 'needs_operator': return { text: '下载失败 · 需要处理', tone: 'dang' };
    case 'pending': return { text: '待处理', tone: 'mute' };
    default: return { text: v ? '处理中' : '—', tone: 'mute' };
  }
}

/** 旧物业库（192.168.1.80）同步状态 */
export function legacyStatusLabel(v?: string | null): { text: string; tone: string } {
  switch (v) {
    case 'synced': return { text: '已同步', tone: 'ok' };
    case 'conflict': return { text: '数据冲突', tone: 'dang' };
    case 'waiting_retry': return { text: '等待重试', tone: 'warn' };
    case 'pending': return { text: '同步中', tone: 'mute' };
    default: return { text: v ? '同步中' : '—', tone: 'mute' };
  }
}

/** 状态码原样放进 title，技术人员排查时还能看到原始值 */
export const rawTitle = (v?: string | null) => (v ? `原始状态：${v}` : undefined);
