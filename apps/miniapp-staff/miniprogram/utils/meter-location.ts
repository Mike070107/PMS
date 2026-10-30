/** 现场定位统一使用GCJ-02，不能把失败/超时伪装成0,0或沿用上一张照片的位置。 */
export interface MeterLocationPoint { latitude: number; longitude: number; accuracy?: number; capturedAt: number; }
export function getMeterLocation(timeoutMs = 9000): Promise<MeterLocationPoint> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const done = (error?: Error, point?: MeterLocationPoint) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) reject(error); else resolve(point!);
    };
    const timer = setTimeout(() => done(new Error('定位超时，请到信号较好的位置重新定位')), timeoutMs);
    try {
      wx.getLocation({ type: 'gcj02', isHighAccuracy: true, highAccuracyExpireTime: 4000,
        success: (res) => {
          if (!Number.isFinite(res.latitude) || !Number.isFinite(res.longitude) || Math.abs(res.latitude) > 90 || Math.abs(res.longitude) > 180) {
            done(new Error('定位返回无效坐标，请重新定位')); return;
          }
          done(undefined, { latitude: res.latitude, longitude: res.longitude,
            accuracy: Number.isFinite(res.accuracy) && res.accuracy >= 0 ? res.accuracy : undefined, capturedAt: Date.now() });
        },
        fail: (error) => {
          const message = String(error?.errMsg || '');
          done(new Error(/privacy|隐私/i.test(message) ? '请先同意小程序隐私授权，再重新定位'
            : /auth|permission|deny|denied/i.test(message) ? '定位权限未开启，请在微信设置中允许使用位置'
            : '定位失败，请检查手机定位服务、微信权限和网络后重试'));
        },
      });
    } catch { done(new Error('定位暂不可用，请在微信中重新打开此页面')); }
  });
}
