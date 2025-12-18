#!/bin/bash
case "$1" in
    start)
        echo "启动物业收费系统..."
        cd /var/www/web_app
        source venv/bin/activate
        nohup python3 app.py > app.log 2>&1 &
        echo "✓ 已启动，PID: $!"
        ;;
    stop)
        echo "停止物业收费系统..."
        pkill -f "python3 app.py"
        echo "✓ 已停止"
        ;;
    restart)
        $0 stop
        sleep 2
        $0 start
        ;;
    status)
        if ps aux | grep -q "python3 app.py" | grep -v grep; then
            echo "✓ 系统正在运行"
            ps aux | grep "python3 app.py" | grep -v grep
        else
            echo "✗ 系统已停止"
        fi
        ;;
    log)
        tail -50 /var/www/web_app/app.log
        ;;
    *)
        echo "用法: $0 {start|stop|restart|status|log}"
        echo ""
        echo "当前状态:"
        $0 status
        echo ""
        echo "访问地址: http://$(hostname -I | awk '{print $1}'):5000"
        echo "测试API: curl http://localhost:5000/api/test"
        ;;
esac
