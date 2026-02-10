#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
应用程序资源管理优化脚本
专门解决Flask应用中的文件描述符泄漏问题
"""

import os
import sys
import gc
import psutil
import logging
from contextlib import contextmanager
from functools import wraps

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('resource_fix.log', encoding='utf-8'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

class ResourceManager:
    """资源管理器 - 监控和优化文件描述符使用"""
    
    def __init__(self):
        self.process = psutil.Process()
        self.initial_fds = self.process.num_fds()
        self.max_fds = self._get_system_fd_limit()
        
    def _get_system_fd_limit(self):
        """获取系统文件描述符限制"""
        try:
            import resource
            soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
            return soft
        except:
            return 1024  # 默认值
            
    def monitor_fds(self):
        """监控文件描述符使用情况"""
        current_fds = self.process.num_fds()
        usage_percent = (current_fds / self.max_fds) * 100
        
        logger.info(f"文件描述符使用: {current_fds}/{self.max_fds} ({usage_percent:.1f}%)")
        
        if usage_percent > 80:
            logger.warning(f"文件描述符使用率过高: {usage_percent:.1f}%")
            self._analyze_fd_usage()
            
        return current_fds, usage_percent
    
    def _analyze_fd_usage(self):
        """分析文件描述符使用详情"""
        try:
            # 获取进程打开的文件
            open_files = self.process.open_files()
            logger.info(f"打开的文件数: {len(open_files)}")
            
            # 统计文件类型
            file_types = {}
            for f in open_files:
                ext = os.path.splitext(f.path)[1] if '.' in f.path else 'no_ext'
                file_types[ext] = file_types.get(ext, 0) + 1
            
            logger.info("文件类型统计:")
            for ext, count in sorted(file_types.items(), key=lambda x: x[1], reverse=True):
                logger.info(f"  {ext}: {count}")
                
        except Exception as e:
            logger.error(f"分析文件描述符时出错: {e}")
    
    def force_garbage_collection(self):
        """强制垃圾回收"""
        collected = gc.collect()
        logger.info(f"垃圾回收: {collected} 个对象")
        return collected

def safe_context_manager(func):
    """安全的上下文管理装饰器"""
    @wraps(func)
    @contextmanager
    def wrapper(*args, **kwargs):
        resource_manager = ResourceManager()
        initial_fds, _ = resource_manager.monitor_fds()
        
        try:
            yield func(*args, **kwargs)
        except Exception as e:
            logger.error(f"执行过程中出错: {e}")
            raise
        finally:
            # 确保资源清理
            final_fds, usage_percent = resource_manager.monitor_fds()
            fd_increase = final_fds - initial_fds
            
            if fd_increase > 0:
                logger.warning(f"文件描述符增加: {fd_increase} (初始: {initial_fds}, 最终: {final_fds})")
                resource_manager.force_garbage_collection()
            elif fd_increase < 0:
                logger.info(f"文件描述符减少: {abs(fd_increase)}")
            else:
                logger.info("文件描述符数量保持不变")
                
    return wrapper

class DatabaseConnectionManager:
    """数据库连接管理器"""
    
    def __init__(self, app):
        self.app = app
        self.max_connections = 20
        self.connection_timeout = 30
        
    @safe_context_manager
    def get_db_session(self):
        """安全获取数据库会话"""
        from app import db
        session = db.session
        try:
            yield session
        except Exception as e:
            session.rollback()
            logger.error(f"数据库操作出错: {e}")
            raise
        finally:
            session.close()
            # 强制清理 SQLAlchemy 的连接池
            try:
                db.engine.dispose()
            except:
                pass

class FileHandlerManager:
    """文件句柄管理器"""
    
    @staticmethod
    @safe_context_manager
    def open_file(filepath, mode='r', encoding='utf-8'):
        """安全打开文件"""
        file_handle = None
        try:
            file_handle = open(filepath, mode, encoding=encoding)
            yield file_handle
        finally:
            if file_handle and not file_handle.closed:
                file_handle.close()
                logger.debug(f"已关闭文件: {filepath}")

def optimize_flask_app(app):
    """优化Flask应用的资源配置"""
    
    # 1. 优化数据库连接池
    app.config.update({
        'SQLALCHEMY_ENGINE_OPTIONS': {
            'pool_pre_ping': True,          # 连接前检测
            'pool_recycle': 1800,           # 30分钟回收连接
            'pool_timeout': 10,             # 连接超时时间缩短
            'max_overflow': 2,              # 减少溢出连接
            'pool_size': 5,                 # 减少连接池大小
            'pool_reset_on_return': 'rollback'  # 返回时重置连接
        }
    })
    
    # 2. 优化日志配置
    import logging.handlers
    from logging.handlers import TimedRotatingFileHandler
    
    # 使用更保守的日志轮转设置
    if hasattr(app, 'logger'):
        for handler in app.logger.handlers[:]:
            app.logger.removeHandler(handler)
            
        # 创建优化的日志处理器
        log_handler = TimedRotatingFileHandler(
            'app_optimized.log',
            when='midnight',
            interval=1,
            backupCount=3,          # 减少备份文件数量
            encoding='utf-8',
            delay=True              # 延迟打开文件
        )
        log_handler.setLevel(logging.INFO)
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        log_handler.setFormatter(formatter)
        app.logger.addHandler(log_handler)
        app.logger.setLevel(logging.INFO)
    
    # 3. 添加请求后清理钩子
    @app.teardown_appcontext
    def cleanup_db_session(exception):
        """请求后清理数据库会话"""
        from app import db
        try:
            db.session.remove()
            # 定期清理连接池
            if not hasattr(app, '_cleanup_counter'):
                app._cleanup_counter = 0
            app._cleanup_counter += 1
            if app._cleanup_counter % 100 == 0:  # 每100次请求清理一次
                db.engine.dispose()
                app._cleanup_counter = 0
                logger.info("执行周期性数据库连接池清理")
        except Exception as e:
            logger.error(f"清理数据库会话时出错: {e}")
    
    # 4. 添加资源监控中间件
    @app.before_request
    def monitor_resources():
        """请求前资源监控"""
        if not hasattr(app, '_resource_manager'):
            app._resource_manager = ResourceManager()
        
        # 每10个请求检查一次资源使用
        if not hasattr(app, '_request_count'):
            app._request_count = 0
        app._request_count += 1
        
        if app._request_count % 10 == 0:
            app._resource_manager.monitor_fds()
    
    logger.info("Flask应用资源配置优化完成")
    return app

def main():
    """主函数 - 应用资源优化"""
    logger.info("开始应用程序资源优化...")
    
    try:
        # 导入Flask应用
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from app import app
        
        # 应用优化
        optimize_flask_app(app)
        
        # 创建资源管理器进行初始检查
        rm = ResourceManager()
        rm.monitor_fds()
        rm.force_garbage_collection()
        
        logger.info("应用程序资源优化完成!")
        logger.info("建议定期运行此脚本来监控资源使用情况")
        
    except ImportError as e:
        logger.error(f"无法导入Flask应用: {e}")
        logger.info("请确保在正确的目录下运行此脚本")
    except Exception as e:
        logger.error(f"优化过程中出错: {e}")
        raise

if __name__ == "__main__":
    main()