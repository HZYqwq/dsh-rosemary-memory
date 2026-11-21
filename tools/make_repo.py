"""把 dsh-rosemary-memory 整理成可以推到 GitHub 的仓库。

做的事，按顺序：

  1. 检查 git / node 是否可用
  2. 跑密钥扫描，不干净就直接停
  3. 检查有没有不该进仓库的文件（data/、node_modules、日志、证书、压缩包）
  4. node --check 所有运行时文件
  5. 确认 .gitignore 排除了 data/
  6. git init -b main + add + 首次提交（--check 时只打印将要发生的动作）
  7. 打印推到 GitHub 的下一步

用法：
    python -X utf8 tools/make_repo.py          # 真的执行
    python -X utf8 tools/make_repo.py --check  # 只检查，不动仓库
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DRY = '--check' in sys.argv

GIT_NAME = 'HZY'
GIT_EMAIL = '122354771+HZYqwq@users.noreply.github.com'
BRANCH = 'main'

# 一旦进了历史就很难清掉，宁可错杀
FORBIDDEN_SUFFIX = {'.log', '.zip', '.7z', '.rar', '.exe', '.dll', '.pem', '.key', '.p12', '.pfx'}
FORBIDDEN_DIRS = {'data', 'node_modules', '.git', '.dsh-ppt', 'render'}
DATA_SUFFIX = {'.jsonl', '.ndjson'}

SECRET_PATTERNS = [
    (re.compile(r'sk-[A-Za-z0-9_\-]{20,}'), 'OpenAI-style key'),
    (re.compile(r'ghp_[A-Za-z0-9]{20,}'), 'GitHub token'),
    (re.compile(r'gho_[A-Za-z0-9]{20,}'), 'GitHub token'),
    (re.compile(r'AKIA[0-9A-Z]{16}'), 'AWS access key'),
    (re.compile(r'(?i)(api[_-]?key|secret|passw(?:or)?d|access[_-]?token|auth[_-]?token)'
                r'\s*[:=]\s*[\'"][^\'"\s]{12,}[\'"]'), 'inline credential'),
    (re.compile(r'(?i)bearer\s+[A-Za-z0-9._\-]{24,}'), 'bearer token'),
    # 真实的本机路径不是密钥，但会把作者环境漏出去；这里只警告不阻断
]

WARN_PATTERNS = [
    (re.compile(r'[A-Za-z]:\\\\Users\\\\[^\\\\\s]+'), '本机绝对路径（会暴露用户名）'),
]

failures = []
warnings = []


def run(cmd, cwd=ROOT, capture=True):
    return subprocess.run(cmd, cwd=str(cwd), capture_output=capture, text=True,
                          encoding='utf-8', errors='replace')


def trackable_files():
    """会进仓库的文件：跳过 .gitignore 已排除的目录与二进制。"""
    for path in ROOT.rglob('*'):
        if not path.is_file():
            continue
        rel = path.relative_to(ROOT)
        if any(part in FORBIDDEN_DIRS for part in rel.parts):
            continue
        yield path, rel


def step(title):
    print(f'\n== {title} ==')


def check_git():
    step('1. 工具链')
    git = run(['git', '--version'])
    if git.returncode != 0:
        failures.append('找不到 git，先装 git 再跑这个脚本')
        return False
    print('   ', git.stdout.strip())
    node = run(['node', '--version'])
    if node.returncode == 0:
        print('   ', node.stdout.strip())
    else:
        warnings.append('找不到 node，语法检查会跳过（CI 里还会再查一次）')
    return True


def scan_secrets():
    step('2. 密钥扫描')
    hits = 0
    for path, rel in trackable_files():
        if path.suffix.lower() in {'.png', '.jpg', '.webp', '.ico'}:
            continue
        try:
            text = path.read_text(encoding='utf-8')
        except (UnicodeDecodeError, OSError):
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            for pattern, label in SECRET_PATTERNS:
                if pattern.search(line):
                    hits += 1
                    failures.append(f'{rel}:{lineno} 疑似 {label}：{line.strip()[:100]}')
            for pattern, label in WARN_PATTERNS:
                if pattern.search(line):
                    warnings.append(f'{rel}:{lineno} {label}：{line.strip()[:100]}')
    if hits == 0:
        print('    干净，没有发现密钥')


def check_forbidden():
    step('3. 不该进仓库的文件')
    bad = 0
    for path, rel in trackable_files():
        suffix = path.suffix.lower()
        if suffix in FORBIDDEN_SUFFIX or suffix in DATA_SUFFIX:
            bad += 1
            failures.append(f'{rel}：不应提交（{suffix}）')
    if (ROOT / 'data').exists() and (ROOT / '.gitignore').exists():
        ignored = (ROOT / '.gitignore').read_text(encoding='utf-8')
        if 'data/' not in ignored:
            failures.append('.gitignore 没有排除 data/')
    if bad == 0:
        print('    没有 data/、日志、安装包或证书')


def check_syntax():
    step('4. 语法检查')
    files = [ROOT / 'index.js', ROOT / 'client.js'] + sorted((ROOT / 'lib').glob('*.js'))
    skipped = False
    for path in files:
        if not path.exists():
            continue
        result = run(['node', '--check', str(path)])
        if result.returncode != 0:
            if '找不到' in (result.stderr or '') or result.returncode == 9009:
                skipped = True
                break
            failures.append(f'{path.name} 语法错误：{result.stderr.strip()[:200]}')
        else:
            print(f'    ok  {path.relative_to(ROOT)}')
    if skipped:
        warning = '没有 node，跳过语法检查'
        if warning not in warnings:
            warnings.append(warning)


def git_init_and_commit():
    step('5. 本地仓库')
    git_dir = ROOT / '.git'

    if git_dir.exists():
        result = run(['git', 'status', '--porcelain'])
        if result.returncode != 0:
            failures.append(
                '.git 已存在但 git 无法操作它。多半是属主问题（管理员组 S-1-5-32-544 建的），'
                '先执行：git config --global --add safe.directory "' + str(ROOT).replace('\\', '/') + '"')
            return
        branch = run(['git', 'branch', '--show-current']).stdout.strip()
        print(f'    仓库已存在，当前分支 {branch or "(detached)"}')
        dirty = [line for line in result.stdout.splitlines() if line.strip()]
        print(f'    待提交改动 {len(dirty)} 项')
    else:
        if DRY:
            print(f'    [dry-run] git init -b {BRANCH}')
            print(f'    [dry-run] git config user.name "{GIT_NAME}" / user.email "{GIT_EMAIL}"')
            print('    [dry-run] git add -A')
            print('    [dry-run] git commit -m "..."')
            return
        init = run(['git', 'init', '-b', BRANCH])
        if init.returncode != 0:
            failures.append(f'git init 失败：{init.stderr.strip()[:200]}')
            return
        print(f'    已初始化，分支 {BRANCH}')

    if DRY:
        print('    [dry-run] 不写 git config、不 add、不 commit')
        return

    run(['git', 'config', 'user.name', GIT_NAME])
    run(['git', 'config', 'user.email', GIT_EMAIL])
    run(['git', 'checkout', '-B', BRANCH])
    print(f'    提交身份 {GIT_NAME} <{GIT_EMAIL}>')

    add = run(['git', 'add', '-A'])
    if add.returncode != 0:
        failures.append(f'git add 失败：{add.stderr.strip()[:200]}')
        return

    tracked = run(['git', 'ls-files']).stdout.splitlines()
    leaks = [f for f in tracked if f.startswith('data/') or Path(f).suffix.lower() in DATA_SUFFIX]
    if leaks:
        failures.append('这些文件被 add 了，必须撤回：' + ', '.join(leaks[:5]))
        return
    print(f'    暂存 {len(tracked)} 个文件，data/ 未进索引')

    if not tracked:
        failures.append('没有文件被暂存，检查 .gitignore')
        return

    commit = run(['git', 'commit', '-m', 'dsh-rosemary-memory 0.3.0: 可审计的跨会话记忆'])
    if commit.returncode != 0:
        failures.append(f'git commit 失败：{(commit.stderr or commit.stdout).strip()[:300]}')
        return
    print('    首次提交完成')


def next_steps():
    step('6. 推到 GitHub')
    remote = run(['git', 'remote', '-v'])
    has_origin = 'origin' in (remote.stdout or '')
    if has_origin:
        print('    已有 origin：')
        for line in remote.stdout.strip().splitlines():
            print('      ', line.strip())
        print(f'\n    推送： git push -u origin {BRANCH}')
        return
    print('    1) 打开 https://github.com/new')
    print('    2) 仓库名 dsh-rosemary-memory，描述 "Auditable cross-session memory for DeepSeek Harness"')
    print('    3) 选 Public')
    print('    4) 不要勾 Add a README / Add .gitignore / Choose a license（本地都有，勾了会冲突）')
    print('    5) 创建后执行：')
    print('         git remote add origin https://github.com/HZYqwq/dsh-rosemary-memory.git')
    print(f'         git push -u origin {BRANCH}')
    print('\n    注：本机 git 配了全局代理 http.proxy=127.0.0.1:10909，代理没开时会连不上。')
    print('        代理没开就直接绕过：')
    print(f'         git -c http.proxy= -c https.proxy= push -u origin {BRANCH}')


def main():
    print(f'仓库目录：{ROOT}')
    print('模式：' + ('只检查（--check）' if DRY else '真实执行'))
    if not check_git():
        summarize()
        return
    scan_secrets()
    check_forbidden()
    check_syntax()
    git_init_and_commit()
    summarize()
    if not failures:
        next_steps()


def summarize():
    if warnings:
        step('警告（不阻断）')
        for item in warnings:
            print('   !', item)
    if failures:
        step('失败')
        for item in failures:
            print('   x', item)
        print('\n先修完上面的问题再推送。')
        sys.exit(1)
    step('通过')
    print('    没有发现阻塞问题。')


if __name__ == '__main__':
    main()
