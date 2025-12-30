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
            if (!str || str.length === 0) {
                return '00000000000000000000000000000000';
            }
            
            // 使用多个哈希值组合生成32位16进制
            let hash1 = 0;
            let hash2 = 0;
            
            for (let i = 0; i < str.length; i++) {
                const char = str.charCodeAt(i);
                hash1 = ((hash1 << 5) - hash1) + char;
                hash1 = hash1 & hash1; // Convert to 32bit integer
                
                hash2 = ((hash2 << 7) - hash2) + char;
                hash2 = hash2 & hash2;
            }
            
            // 转换为16进制并组合
            let hex1 = Math.abs(hash1).toString(16).padStart(16, '0');
            let hex2 = Math.abs(hash2).toString(16).padStart(16, '0');
            
            // 组合并截取前32位
            let result = (hex1 + hex2).substring(0, 32);
            
            // 确保长度为32
            return result.padEnd(32, '0');
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
