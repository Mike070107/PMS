#!/usr/bin/env python3
import sys

# 读取文件
with open('app.py', 'r', encoding='utf-8') as f:
    lines = f.readlines()

print(f"文件总行数: {len(lines)}")
print(f"检查第29行: '{lines[28].strip() if len(lines) > 28 else 'EOF'}'")

# 检查第29行及附近
print("\n=== 第25-35行内容 ===")
for i in range(24, min(35, len(lines))):
    print(f"{i+1:3}: {lines[i].rstrip()}")

# 检查常见的语法问题
print("\n=== 语法检查 ===")

# 检查是否有在if语句中赋值
for i, line in enumerate(lines):
    if 'if' in line and '=' in line and '==' not in line:
        print(f"⚠ 第{i+1}行: 可能应该在if语句中使用==而不是=")

# 检查括号是否匹配
paren_stack = []
for i, line in enumerate(lines):
    for j, char in enumerate(line):
        if char == '(':
            paren_stack.append((i+1, j+1))
        elif char == ')':
            if paren_stack:
                paren_stack.pop()
            else:
                print(f"⚠ 第{i+1}行: 多余的右括号")

if paren_stack:
    for line_num, col in paren_stack:
        print(f"⚠ 第{line_num}行: 未闭合的左括号")

# 尝试自动修复常见的错误
new_lines = []
modified = False

for i, line in enumerate(lines):
    # 检查 if 语句中的 = 应该改为 ==
    if i == 28:  # 第29行（索引从0开始）
        original_line = line.rstrip()
        
        # 常见错误模式1: if something = value:
        if 'if' in line and '=' in line and '==' not in line and ':' in line:
            # 替换单个 = 为 ==
            fixed_line = line.replace(' = ', ' == ', 1)
            print(f"修复第{i+1}行: if语句中的赋值运算符")
            print(f"  原: {original_line}")
            print(f"  改: {fixed_line.strip()}")
            new_lines.append(fixed_line)
            modified = True
        
        # 常见错误模式2: 这行是独立的赋值语句，但被前面的错误影响了
        elif 'app.config[' in line and "'SECRET_KEY'" in line and '=' in line:
            # 确保这行是正确的赋值语句
            if line.strip().startswith('app.config['):
                print(f"第{i+1}行看起来是正确的赋值语句: {original_line}")
                new_lines.append(line)
            else:
                print(f"第{i+1}行可能有格式问题")
                new_lines.append(line)
        else:
            new_lines.append(line)
    else:
        new_lines.append(line)

# 如果修改了，备份并写入
if modified:
    # 备份原文件
    import shutil
    shutil.copy2('app.py', 'app.py.before_syntax_fix')
    
    # 写入修复后的文件
    with open('app.py', 'w', encoding='utf-8') as f:
        f.writelines(new_lines)
    
    print("\n✅ 已尝试自动修复，请重新运行应用")
else:
    print("\n⚠ 未发现可自动修复的问题，需要手动检查")

print("\n建议:")
print("1. 检查第29行及前面几行的代码结构")
print("2. 确保赋值语句不在条件表达式中")
print("3. 检查括号、引号是否正确闭合")
