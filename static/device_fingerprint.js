/**
 * 设备指纹生成工具
 * 由于浏览器无法直接获取真实MAC地址，生成基于浏览器特征的设备指纹ID
 */

(function(window) {
    'use strict';
    
    const DeviceFingerprint = {
        /**
         * 生成设备指纹ID
         * @returns {string} 32位16进制设备指纹ID
         */
        generate: function() {
            const features = [];
            
            // 1. 用户代理
            features.push(navigator.userAgent || '');
            
            // 2. 语言
            features.push(navigator.language || '');
            
            // 3. 屏幕分辨率
            features.push(screen.width + 'x' + screen.height);
            features.push(screen.colorDepth);
            
            // 4. 时区偏移
            features.push(new Date().getTimezoneOffset());
            
            // 5. 平台
            features.push(navigator.platform || '');
            
            // 6. Cookie启用状态
            features.push(navigator.cookieEnabled);
            
            // 7. 硬件并发数
            features.push(navigator.hardwareConcurrency || '');
            
            // 8. 设备内存（如果支持）
            features.push(navigator.deviceMemory || '');
            
            // 9. Canvas指纹
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                ctx.textBaseline = 'top';
                ctx.font = '14px Arial';
                ctx.fillText('Device Fingerprint', 2, 2);
                features.push(canvas.toDataURL());
            } catch(e) {
                features.push('canvas_error');
            }
            
            // 10. WebGL指纹
            try {
                const canvas = document.createElement('canvas');
                const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
                if (gl) {
                    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
                    if (debugInfo) {
                        features.push(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL));
                        features.push(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL));
                    }
                }
            } catch(e) {
                features.push('webgl_error');
            }
            
            // 合并所有特征
            const fingerprint = features.join('|||');
            
            // 使用简单的哈希算法生成32位16进制ID
            return this.simpleHash(fingerprint);
        },
        
        /**
         * 简单哈希算法
         * @param {string} str 
         * @returns {string} 32位16进制哈希值
         */
        simpleHash: function(str) {
            let hash = 0;
            if (str.length === 0) return '00000000000000000000000000000000';
            
            for (let i = 0; i < str.length; i++) {
                const char = str.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash; // Convert to 32bit integer
            }
            
            // 转换为16进制，确保32位长度
            let hex = Math.abs(hash).toString(16);
            while (hex.length < 32) {
                // 使用字符串的不同部分继续生成
                const extraHash = this.simpleHash(str.substring(hex.length % str.length));
                hex += extraHash.substring(0, 32 - hex.length);
            }
            
            return hex.substring(0, 32);
        },
        
        /**
         * 获取或生成设备指纹ID（带缓存）
         * @returns {string} 设备指纹ID
         */
        getOrCreate: function() {
            const storageKey = 'device_fingerprint_id';
            
            // 尝试从localStorage读取
            try {
                let fingerprintId = localStorage.getItem(storageKey);
                if (fingerprintId) {
                    return fingerprintId;
                }
            } catch(e) {
                console.warn('无法访问localStorage:', e);
            }
            
            // 生成新的指纹ID
            const fingerprintId = this.generate();
            
            // 保存到localStorage
            try {
                localStorage.setItem(storageKey, fingerprintId);
            } catch(e) {
                console.warn('无法保存到localStorage:', e);
            }
            
            return fingerprintId;
        },
        
        /**
         * 格式化为MAC地址样式（仅供显示）
         * @param {string} fingerprintId 
         * @returns {string} 格式：XX:XX:XX:XX:XX:XX
         */
        formatAsMAC: function(fingerprintId) {
            if (!fingerprintId || fingerprintId.length < 12) {
                return '00:00:00:00:00:00';
            }
            
            // 取前12位，格式化为MAC地址样式
            const macParts = [];
            for (let i = 0; i < 12; i += 2) {
                macParts.push(fingerprintId.substring(i, i + 2).toUpperCase());
            }
            
            return macParts.join(':');
        }
    };
    
    // 暴露到全局
    window.DeviceFingerprint = DeviceFingerprint;
    
})(window);
