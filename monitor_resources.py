#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
服务器资源监控脚本
实时监控文件描述符、内存和CPU使用情况
"""

import psutil
import time
import logging
import sys
import os
from datetime import datetime

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('server_monitor.log', encoding='utf-8'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

class ServerMonitor:
    """服务器资源监控器"""
    
    def __init__(self, pid=None):
        self.process = psutil.Process(pid) if pid else psutil.Process()
        self.system = psutil
        self.alert_thresholds = {
            'fd_usage': 80,      # 文件描述符使用率阈值
            'memory_usage': 85,  # 内存使用率阈值
            'cpu_usage': 80      # CPU使用率阈值
        }
        
    def get_process_info(self):
        """获取进程信息"""
        try:
            info = {
                'pid': self.process.pid,
                'name': self.process.name(),
                'status': self.process.status(),
                'create_time': datetime.fromtimestamp(self.process.create_time()),
                'fd_count': self.process.num_fds(),
                'memory_info': self.process.memory_info(),
                'cpu_percent': self.process.cpu_percent(),
                'threads': self.process.num_threads()
            }
            return info
        except Exception as e:
            logger.error(f"获取进程信息失败: {e}")
            return None
    
    def get_system_info(self):
        """获取系统信息"""
        try:
            info = {
                'cpu_percent': self.system.cpu_percent(interval=1),
                'memory': self.system.virtual_memory(),
                'disk': self.system.disk_usage('/'),
                'fd_max': self._get_fd_limit(),
                'fd_allocated': self._get_allocated_fds()
            }
            return info
        except Exception as e:
            logger.error(f"获取系统信息失败: {e}")
            return None
    
    def _get_fd_limit(self):
        """获取文件描述符限制"""
        try:
            import resource
            soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
            return soft
        except:
            return 1024
    
    def _get_allocated_fds(self):
        """获取系统已分配的文件描述符"""
        try:
            with open('/proc/sys/fs/file-nr', 'r') as f:
                return int(f.read().split()[0])
        except:
            return 0
    
    def check_alerts(self, proc_info, sys_info):
        """检查告警条件"""
        alerts = []
        
        # 检查文件描述符使用率
        if proc_info and sys_info:
            fd_usage = (proc_info['fd_count'] / sys_info['fd_max']) * 100
            if fd_usage > self.alert_thresholds['fd_usage']:
                alerts.append(f"文件描述符使用率过高: {fd_usage:.1f}% "
                            f"(当前: {proc_info['fd_count']}, 最大: {sys_info['fd_max']})")
        
        # 检查内存使用率
        if sys_info and sys_info['memory'].percent > self.alert_thresholds['memory_usage']:
            alerts.append(f"内存使用率过高: {sys_info['memory'].percent:.1f}%")
        
        # 检查CPU使用率
        if proc_info and proc_info['cpu_percent'] > self.alert_thresholds['cpu_usage']:
            alerts.append(f"CPU使用率过高: {proc_info['cpu_percent']:.1f}%")
        
        return alerts
    
    def print_status(self, proc_info, sys_info, alerts):
        """打印状态信息"""
        print("\n" + "="*60)
        print(f"监控时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print("="*60)
        
        if proc_info:
            print(f"进程信息 (PID: {proc_info['pid']})")
            print(f"  名称: {proc_info['name']}")
            print(f"  状态: {proc_info['status']}")
            print(f"  文件描述符: {proc_info['fd_count']}")
            print(f"  内存使用: {proc_info['memory_info'].rss / 1024 / 1024:.1f} MB")
            print(f"  CPU使用率: {proc_info['cpu_percent']:.1f}%")
            print(f"  线程数: {proc_info['threads']}")
        
        if sys_info:
            print(f"\n系统信息")
            print(f"  CPU使用率: {sys_info['cpu_percent']:.1f}%")
            print(f"  内存使用率: {sys_info['memory'].percent:.1f}%")
            print(f"  可用内存: {sys_info['memory'].available / 1024 / 1024 / 1024:.1f} GB")
            print(f"  磁盘使用率: {sys_info['disk'].percent:.1f}%")
            print(f"  文件描述符使用: {sys_info['fd_allocated']} / {sys_info['fd_max']}")
        
        if alerts:
            print(f"\n⚠️  告警信息:")
            for alert in alerts:
                print(f"  - {alert}")
        else:
            print(f"\n✅ 系统状态正常")
        
        print("="*60)
    
    def run_monitor(self, interval=5, duration=None):
        """运行监控"""
        print("开始服务器资源监控...")
        print(f"监控间隔: {interval}秒")
        if duration:
            print(f"监控时长: {duration}秒")
        
        start_time = time.time()
        
        try:
            while True:
                # 获取信息
                proc_info = self.get_process_info()
                sys_info = self.get_system_info()
                
                # 检查告警
                alerts = self.check_alerts(proc_info, sys_info)
                
                # 打印状态
                self.print_status(proc_info, sys_info, alerts)
                
                # 记录到日志
                if alerts:
                    for alert in alerts:
                        logger.warning(alert)
                
                # 检查是否达到监控时长
                if duration and (time.time() - start_time) >= duration:
                    print(f"\n监控完成，时长: {duration}秒")
                    break
                
                # 等待下次监控
                time.sleep(interval)
                
        except KeyboardInterrupt:
            print("\n\n监控被用户中断")
        except Exception as e:
            logger.error(f"监控过程中出错: {e}")
            raise

def main():
    """主函数"""
    import argparse
    
    parser = argparse.ArgumentParser(description='服务器资源监控工具')
    parser.add_argument('-p', '--pid', type=int, help='要监控的进程PID')
    parser.add_argument('-i', '--interval', type=int, default=5, help='监控间隔(秒)')
    parser.add_argument('-d', '--duration', type=int, help='监控时长(秒)')
    parser.add_argument('--fd-threshold', type=int, default=80, help='文件描述符告警阈值(%)')
    parser.add_argument('--memory-threshold', type=int, default=85, help='内存告警阈值(%)')
    parser.add_argument('--cpu-threshold', type=int, default=80, help='CPU告警阈值(%)')
    
    args = parser.parse_args()
    
    # 创建监控器
    monitor = ServerMonitor(pid=args.pid)
    
    # 设置告警阈值
    monitor.alert_thresholds['fd_usage'] = args.fd_threshold
    monitor.alert_thresholds['memory_usage'] = args.memory_threshold
    monitor.alert_thresholds['cpu_usage'] = args.cpu_threshold
    
    # 运行监控
    monitor.run_monitor(interval=args.interval, duration=args.duration)

if __name__ == "__main__":
    main()