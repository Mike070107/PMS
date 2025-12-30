# 下载CDN资源到本地
# 创建目录
$libPath = "static\lib"
New-Item -ItemType Directory -Force -Path $libPath | Out-Null

# 下载 Element Plus
Write-Host "正在下载 Element Plus..." -ForegroundColor Green
Invoke-WebRequest -Uri "https://unpkg.com/element-plus@2.3.14/dist/index.full.js" -OutFile "$libPath\element-plus.full.js"
Invoke-WebRequest -Uri "https://unpkg.com/element-plus@2.3.14/dist/index.css" -OutFile "$libPath\element-plus.css"

# 下载 Axios
Write-Host "正在下载 Axios..." -ForegroundColor Green
Invoke-WebRequest -Uri "https://unpkg.com/axios@1.4.0/dist/axios.min.js" -OutFile "$libPath\axios.min.js"

# 下载 ECharts
Write-Host "正在下载 ECharts..." -ForegroundColor Green
Invoke-WebRequest -Uri "https://cdn.bootcdn.net/ajax/libs/echarts/5.4.3/echarts.min.js" -OutFile "$libPath\echarts.min.js"

# 下载 Element Plus Icons
Write-Host "正在下载 Element Plus Icons..." -ForegroundColor Green  
Invoke-WebRequest -Uri "https://unpkg.com/@element-plus/icons-vue@2.1.0/dist/index.iife.min.js" -OutFile "$libPath\element-plus-icons.umd.js"

Write-Host "`n✅ 所有资源下载完成！" -ForegroundColor Green
Write-Host "文件保存在: $libPath" -ForegroundColor Cyan
