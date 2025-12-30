#!/bin/bash
if ! ps aux | grep -q "python3 app.py" | grep -v grep; then
    echo "重启物业收费系统..."
    cd /var/www/web_app
    source venv/bin/activate
    nohup python3 app.py > app.log 2>&1 &
fi
