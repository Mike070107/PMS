/**
 * API请求拦截器 - 自动添加设备指纹到请求头
 * 依赖：device_fingerprint.js
 */

(function(window) {
    'use strict';
    
    // 等待DOM加载完成后初始化
    function initInterceptor() {
        // 等待DeviceFingerprint加载
        if (typeof window.DeviceFingerprint === 'undefined') {
            console.error('device_fingerprint.js 必须先加载');
            return;
        }
        
        // 获取设备指纹ID
        const deviceId = window.DeviceFingerprint.getOrCreate();
        const macAddress = window.DeviceFingerprint.formatAsMAC(deviceId);
        
        console.log('设备指纹ID:', deviceId);
        console.log('格式化MAC地址:', macAddress);
        
        /**
         * 增强fetch方法，自动添加设备指纹请求头
         */
        const originalFetch = window.fetch;
        window.fetch = function(url, options) {
            options = options || {};
            options.headers = options.headers || {};
            
            // 添加设备指纹到请求头
            if (typeof options.headers.append === 'function') {
                options.headers.append('X-Client-MAC', macAddress);
                options.headers.append('X-Device-ID', deviceId);
            } else if (typeof options.headers === 'object') {
                options.headers['X-Client-MAC'] = macAddress;
                options.headers['X-Device-ID'] = deviceId;
            }
            
            return originalFetch.call(this, url, options);
        };
        
        /**
         * 增强XMLHttpRequest，自动添加设备指纹请求头
         */
        const originalXHROpen = XMLHttpRequest.prototype.open;
        const originalXHRSend = XMLHttpRequest.prototype.send;
        
        XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
            this._url = url;
            this._method = method;
            return originalXHROpen.apply(this, arguments);
        };
        
        XMLHttpRequest.prototype.send = function(data) {
            // 添加设备指纹请求头
            this.setRequestHeader('X-Client-MAC', macAddress);
            this.setRequestHeader('X-Device-ID', deviceId);
            
            return originalXHRSend.apply(this, arguments);
        };
        
        // 暴露到全局，供其他模块使用
        window.CLIENT_MAC = macAddress;
        window.DEVICE_ID = deviceId;
        
        console.log('✓ API请求拦截器已启用，所有API请求将自动携带设备指纹');
    }
    
    // 在DOM加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initInterceptor);
    } else {
        // DOM已经加载完成，直接执行
        initInterceptor();
    }
    
})(window);
