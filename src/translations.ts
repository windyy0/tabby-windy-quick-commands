export type PluginLanguage = 'zh-CN' | 'en'

export function getPluginLanguage (locale: string | null | undefined): PluginLanguage {
    return /^zh(?:-|_|$)/i.test(locale || '') ? 'zh-CN' : 'en'
}

const englishPhrases: Record<string, string> = {
    '用于输出触发器。插件会保留终端最近输出的这些字符，并在其中查找成功或错误关键词。这里按字符数计算，不是行数。数值太小可能让较早的输出被覆盖，导致匹配不到；数值越大则会多占用少量内存。一般保持默认 8000，只有大量连续输出把目标文字冲掉时才需要调大。': 'Used by output triggers. The plugin keeps this many recent terminal output characters and searches them for success or error text. This is a character count, not a line count. Keep the default 8000 unless heavy output pushes the target text out of the buffer.',
    '在 Tabby 中集中管理和执行常用终端命令，支持分类搜索、快捷键、多会话发送、逐行执行、输出触发器以及命令库导入导出。': 'Manage and run frequently used terminal commands in Tabby, with categories, search, shortcuts, multi-session sending, line-by-line execution, output triggers, and library import/export.',
    '请确认目标会话和执行方式。所有会话、多会话、生产会话和高风险命令不会静默执行。': 'Confirm the target sessions and execution mode. Broadcast, multi-session, production-session, and high-risk commands are never run silently.',
    '等待成功或错误输出的最长时间，单位为毫秒；到时后执行右侧的超时动作，最少 100 毫秒。': 'Maximum time to wait for success or error output, in milliseconds. The timeout action is used when it expires; minimum 100 ms.',
    '等待成功或错误输出的最长时间，单位为毫秒；到时后执行右侧的超时动作，最少 100ms。': 'Maximum time to wait for success or error output, in milliseconds. The timeout action is used when it expires; minimum 100 ms.',
    '导出或恢复命令、分类、触发器和所有插件设置；运行日志与使用统计不包含在内。': 'Export or restore commands, categories, triggers, and all plugin settings. Runtime logs and usage statistics are excluded.',
    '合并会跳过全部冲突；替换会忽略与现有库的冲突，但跳过文件内部冲突。': 'Merge skips every conflict. Replace ignores conflicts with the existing library but skips conflicts inside the imported file.',
    '点击输入框后按组合键。在终端中按下即可执行；高风险命令仍需确认。': 'Click the field and press a key combination. Use it in a terminal to run the command; high-risk commands still require confirmation.',
    '命令包含删除、重启、清理或数据库高风险关键字，执行前会二次确认。': 'The command contains high-risk delete, restart, cleanup, or database keywords and requires an extra confirmation.',
    '每个会话独立匹配；后续规则只读取上一条规则结束后的新输出。': 'Each session is matched independently. Later rules only read output produced after the previous rule finishes.',
    '新分类会显示在分类栏里，可以先建空分类，再向其中添加命令。': 'New categories appear in the category bar. You can create an empty category before adding commands to it.',
    '按关键词、分类和使用状态筛选，并按最近使用时间排序，每页 6 条。': 'Filter by keyword, category, and usage, sorted by most recently used, with 6 commands per page.',
    '可能存在大量的bug还有一些没考虑的，见谅🫨可以提issue，慢慢改~': 'There may still be plenty of bugs and overlooked cases, so please bear with me 🫨 Feel free to open an issue; I will improve things over time~',
    '粘贴模式会把命令发送到目标会话，可选择是否自动回车。': 'Paste mode sends the command to the target sessions and can optionally press Enter.',
    '当前会话不支持输出监听，已跳过输出触发器。': 'The current session does not support output monitoring, so output triggers were skipped.',
    '逐行模式支持为每一行设置延迟和执行后暂停。': 'Line-by-line mode supports a delay and pause-after-run setting for each line.',
    '插件配置已导入。按钮显示设置将在重启 Tabby 后生效。': 'Plugin configuration imported. Toolbar button visibility takes effect after restarting Tabby.',
    '当前为执行后暂停，点击改为执行后继续': 'Currently pauses after running; click to continue after running',
    '当前为执行后继续，点击改为执行后暂停': 'Currently continues after running; click to pause after running',
    '修改后重启 Tabby 生效；隐藏按钮后仍可使用快捷键': 'Restart Tabby after changing this setting; shortcuts remain available when the button is hidden',
    '只支持当前版本的快速命令插件配置文件。': 'Only configuration files from the current plugin version are supported.',
    '复制失败，可以手动选中命令内容复制。': 'Copy failed. Select and copy the command text manually.',
    '正则表达式无效，请修正后再执行。': 'The regular expression is invalid. Fix it before running.',
    '绑定的命令行不存在或不可执行，请重新选择触发时机。': 'The bound command line is missing or not executable. Select another trigger time.',
    '该规则仅在逐行模式下生效。': 'This rule only runs in line-by-line mode.',
    '当前行不存在或不可执行': 'The current line is missing or not executable',
    '新建一条命令，或者调整搜索条件。': 'Create a command or change the search filters.',
    '请继续按下字母、数字或功能键。': 'Press a letter, number, or function key to continue.',
    '没有找到可发送命令的终端会话。': 'No terminal session is available for sending the command.',
    '多会话发送会在执行前二次确认。': 'Sending to multiple sessions requires an extra confirmation.',
    '无法触发配置文件下载，请重试。': 'Could not start the configuration download. Try again.',
    '请先进入具体分类后再排序。': 'Open a specific category before sorting.',
    '发送到所有会话时必须确认': 'Require confirmation when sending to all sessions',
    '搜索名称、说明或命令内容': 'Search names, descriptions, or command text',
    '搜索消息、命令或目标会话': 'Search messages, commands, or target sessions',
    '请进入具体分类排序': 'Open a specific category to sort',
    '点击改为执行后继续': 'Click to continue after running',
    '点击改为执行后暂停': 'Click to pause after running',
    '请输入有效的分类名称。': 'Enter a valid category name.',
    '只能在同一分类内排序。': 'Commands can only be sorted within the same category.',
    '先选择或新建一条命令。': 'Select or create a command first.',
    '自动化目标命令不存在': 'Automation target command does not exist',
    '自动化跳过高风险命令': 'Automation skipped a high-risk command',
    '没有匹配的运行日志': 'No matching runtime logs',
    '命令名称不能为空。': 'Command name cannot be empty.',
    '导出失败，请查看 Tabby 日志。': 'Export failed. Check the Tabby logs.',
    '命令库已导出，并已复制 JSON 到剪贴板。': 'Command library exported and its JSON copied to the clipboard.',
    '命令库已导出为 JSON 文件。': 'Command library exported as a JSON file.',
    '命令库已合并导入': 'Command library merged',
    '命令库已替换导入': 'Command library replaced',
    '执行失败，请查看 Tabby 日志。': 'Execution failed. Check the Tabby logs.',
    '配置文件不能超过 5MB。': 'The configuration file cannot exceed 5 MB.',
    '导入文件不能超过 5MB。': 'The import file cannot exceed 5 MB.',
    '已触发插件配置文件下载，请检查下载目录。': 'Configuration download started. Check your downloads folder.',
    '文件下载失败，JSON 已复制到剪贴板。': 'File download failed. The JSON was copied to the clipboard.',
    '快捷键需包含 Ctrl、Alt 或 Meta；也可以直接使用功能键。': 'Shortcuts must include Ctrl, Alt, or Meta; function keys can also be used directly.',
    '点击输入框后按组合键': 'Click the field and press a shortcut',
    '没有匹配的命令': 'No matching commands',
    '确认删除该输出触发器规则？此操作不可撤销。': 'Delete this output trigger rule? This action cannot be undone.',
    '输入要发送到终端的命令': 'Enter the command to send to the terminal',
    '自动化跳过高风险自定义命令': 'Automation skipped a high-risk custom command',
    '自动化已发送自定义命令': 'Automation sent a custom command',
    '输出触发器超时': 'Output trigger timed out',
    '编辑名称和说明': 'Edit name and description',
    '收藏/取消收藏': 'Add/remove favorite',
    '置顶/取消置顶': 'Pin/unpin',
    '发送后自动回车': 'Press Enter after sending',
    '发送自定义命令': 'Send a custom command',
    '执行已有命令': 'Run an existing command',
    '请选择命令': 'Select a command',
    '继续下一条规则': 'Continue to the next rule',
    '跳过该行剩余规则，继续下一行': 'Skip the remaining rules for this line and continue to the next line',
    '删除分类和命令': 'Delete category and commands',
    '分类名称已存在。': 'The category name already exists.',
    '复制当前命令并创建新的命令项': 'Copy the current command into a new item',
    '确认永久删除选中的': 'Permanently delete the selected',
    '条命令？运行日志将保留。': 'commands? Runtime logs will be kept.',
    '默认保留 200 条，最多 2000 条；每页': 'Keeps 200 entries by default and up to 2000;',
    '条，最新日志在前。': 'per page, newest first.',
    '修改后会立即更新左侧命令列表。': 'Changes update the command list immediately.',
    '修改为新的分类名称。': 'to a new category name.',
    '条命令。确认后将同时删除这些命令，此操作无法撤销。': 'commands. Confirming deletes them as well and cannot be undone.',
    '快捷键与 Tabby 内置操作': 'Shortcut conflicts with Tabby action ',
    '行执行后暂停，等待继续。': 'paused after running and is waiting to continue.',
    '行发送失败，需要手动确认后继续。': 'failed to send and needs confirmation to continue.',
    '请输入': 'Enter',
    '后再确认。': 'before confirming.',
    '个失效触发器引用': 'invalid trigger references',
    '会话自动化已在超时后停止': 'Session automation stopped after timing out',
    '会话自动化已在匹配后停止': 'Session automation stopped after a match',
    '等待输出触发器': 'Waiting for output trigger',
    '正在等待：': 'Waiting for: ',
    '已发送到': 'Sent to',
    '个会话。': 'sessions.',
    '已发送第': 'Sent source line',
    '行发送失败。': 'failed to send.',
    '自动化已执行': 'Automation ran',
    '规则正则表达式无效，已跳过': 'Rule has an invalid regular expression and was skipped',
    '命令库版本': 'Command library version',
    '导入文件里没有命令。': 'The import file contains no commands.',
    '命令内容为空。': 'Command text is empty.',
    '配置文件无效。': 'The configuration file is invalid.',
    '没有可用会话': 'No available sessions',
    '文件内部冲突': 'Conflict inside file',
    '编辑命令信息': 'Edit command information',
    '命中错误输出': 'Matched error output',
    '命中成功输出': 'Matched success output',
    '输出匹配规则': 'Output matching rule',
    '发送后回车': 'Press Enter after sending',
    '不自动回车': 'Do not press Enter',
    '可暂停/继续': 'Can pause/resume',
    '副本': 'copy',
    '覆盖': 'Overwrite',
    '包含强制递归删除': 'Contains forced recursive deletion',
    '包含 Windows 强制删除': 'Contains forced Windows deletion',
    '包含目录递归删除': 'Contains recursive directory deletion',
    '包含关机命令': 'Contains a shutdown command',
    '包含重启命令': 'Contains a restart command',
    '包含格式化文件系统': 'Contains filesystem formatting',
    '包含磁盘写入命令': 'Contains a raw disk write',
    '包含 Docker 清理命令': 'Contains a Docker cleanup command',
    '包含 Kubernetes 删除命令': 'Contains a Kubernetes delete command',
    '包含删除数据库': 'Contains a database drop',
    '包含清空表数据': 'Contains table truncation',
    'JSON 格式无效。': 'Invalid JSON.',
    '只支持 v3 命令库对象，不支持旧版数组格式。': 'Only v3 command library objects are supported; legacy array format is not supported.',
    '文件不是 Tabby Windy Quick Commands 命令库。': 'The file is not a Tabby Windy Quick Commands library.',
    '导入文件缺少 commands 数组。': 'The import file is missing the commands array.',
    '导入文件包含的命令超过 5000 条。': 'The import file contains more than 5000 commands.',
    '配置文件包含的命令超过 5000 条。': 'The configuration contains more than 5000 commands.',
    '配置文件格式无效。': 'Invalid configuration file format.',
    '配置文件缺少 config 对象。': 'The configuration file is missing the config object.',
    '配置文件缺少 commands 数组。': 'The configuration file is missing the commands array.',
    '显示右上角按钮': 'Show the top-right toolbar button',
    '每次执行前确认': 'Confirm before every execution',
    '逐行发送失败后': 'After a line fails to send',
    '输出匹配缓冲区': 'Output match buffer',
    '查看输出匹配缓冲区说明': 'View output match buffer help',
    '命令管理与统计': 'Command management and statistics',
    '选择当前页命令': 'Select commands on this page',
    '全部使用状态': 'All usage states',
    '日志保留条数': 'Retained log entries',
    '清空运行日志': 'Clear runtime logs',
    '打开日志位置': 'Open log location',
    '选择命令：': 'Select command: ',
    '重命名分类': 'Rename category',
    '执行后暂停': 'Pause',
    '执行后继续': 'Continue',
    '清空快捷键': 'Clear shortcut',
    '输出触发器': 'Output triggers',
    '正则表达式': 'Regular expression',
    '成功后执行': 'Run on success',
    '错误后执行': 'Run on error',
    '匹配后执行': 'After a match',
    '单条匹配': 'Single pattern',
    '任一行匹配': 'Match any pattern',
    '全部行匹配': 'Match all patterns',
    '输入匹配文本': 'Enter match text',
    '每行一个匹配文本': 'One match pattern per line',
    '不执行': 'Do nothing',
    '不执行命令': 'Do not run a command',
    '停止该会话自动化': 'Stop automation for this session',
    '停止后续逐行执行': 'Stop remaining line-by-line execution',
    '会话已在匹配后跳过该行剩余规则': 'Session skipped the remaining rules for this line after a match',
    '命令已复制。': 'Command copied.',
    '执行已停止。': 'Execution stopped.',
    '未命名会话': 'Unnamed session',
    '未命名命令': 'Unnamed command',
    '运行日志': 'Runtime logs',
    '导出文件名': 'Export file name',
    '快速命令': 'Quick Commands',
    '显示/隐藏快速命令': 'Show/hide Quick Commands',
    '调整宽度': 'Resize',
    '导入命令': 'Import commands',
    '导出命令': 'Export commands',
    '搜索命令': 'Search commands',
    '清空搜索': 'Clear search',
    '更多分类': 'More categories',
    '添加分类': 'Add category',
    '分类操作': 'Category actions',
    '删除分类': 'Delete category',
    '搜索分类': 'Search categories',
    '新建命令': 'New command',
    '新增名称和说明': 'Add name and description',
    '保存后，新命令会添加到左侧命令列表。': 'After saving, the new command appears in the command list.',
    '移动命令': 'Move command',
    '批量移动': 'Move selected',
    '请选择目标分类': 'Select a target category',
    '确认移动': 'Move',
    '选择并移动': 'Select and move',
    '目标分类': 'Target category',
    '移动后跳转到目标分类': 'Go to the target category after moving',
    '移动': 'Move',
    '执行命令': 'Run command',
    '全部折叠': 'Collapse all',
    '全部展开': 'Expand all',
    '上移命令': 'Move command up',
    '下移命令': 'Move command down',
    '删除命令': 'Delete command',
    '更多操作': 'More actions',
    '复制为新命令': 'Duplicate command',
    '基础信息': 'Basic information',
    '名称、分类与说明': 'Name, category, and description',
    '命令内容': 'Command text',
    '逐行执行设置': 'Line-by-line settings',
    '延迟 / 执行后状态': 'Delay / post-run state',
    '延迟 / 执行后状态 / 输出规则': 'Delay / post-run state / output rules',
    '逐行设置': 'Line settings',
    '该行延迟': 'Line delay',
    '执行设置': 'Execution settings',
    '原样发送': 'Send as-is',
    '目标会话': 'Target sessions',
    '当前会话': 'Current session',
    '所有会话': 'All sessions',
    '默认逐行间隔': 'Default line interval',
    '更多设置': 'More settings',
    '点击录入': 'Click to record',
    '暂无规则': 'No rules',
    '启用规则': 'Enable rule',
    '删除规则': 'Delete rule',
    '匹配方式': 'Match mode',
    '普通文本': 'Plain text',
    '成功匹配': 'Success match',
    '错误匹配': 'Error match',
    '等待确认': 'Waiting for confirmation',
    '确认执行': 'Confirm execution',
    '风险提示': 'Risk warning',
    '确认发送': 'Confirm sending',
    '导入预览': 'Import preview',
    '替换导入': 'Replace import',
    '合并导入': 'Merge import',
    '确认删除': 'Confirm deletion',
    '分类名称': 'Category name',
    '失败处理': 'Failure handling',
    '内置操作': 'Built-in action',
    '到剪贴板': 'to clipboard',
    '文件格式': 'File format',
    '导入失败': 'Import failed',
    '开始执行': 'Run',
    '执行完成': 'Execution complete',
    '逐行执行': 'Line-by-line execution',
    '插件配置': 'Plugin configuration',
    '导出配置': 'Export configuration',
    '导入配置': 'Import configuration',
    '继续执行': 'Continue',
    '停止执行': 'Stop',
    '手动确认': 'Ask what to do',
    '面板宽度': 'Panel width',
    '全部分类': 'All categories',
    '从未使用': 'Never used',
    '清除筛选': 'Clear filters',
    '取消选择': 'Clear selection',
    '批量删除': 'Delete selected',
    '执行次数': 'Run count',
    '最近使用': 'Last used',
    '暂无命令': 'No commands',
    '日志级别': 'Log level',
    '从未执行': 'Never run',
    '重新打开标签页': 'Reopen tab',
    '下一个标签页': 'Next tab',
    '上一个标签页': 'Previous tab',
    '命令面板': 'Command palette',
    '配置选择器': 'Profile selector',
    '关闭标签页': 'Close tab',
    '向右分屏': 'Split right',
    '向下分屏': 'Split down',
    '切换配置': 'Switch profile',
    '最大化面板': 'Maximize pane',
    '命令库': 'Command library',
    '快捷键': 'Shortcut',
    '规则名': 'Rule name',
    '触发时机': 'Trigger time',
    '整个命令发送后': 'After the whole command is sent',
    '输出规则': 'Output rules',
    '超时后': 'On timeout',
    '请选择': 'Select',
    '未分类': 'Uncategorized',
    '已暂停': 'Paused',
    '运行中': 'Running',
    '现有库': 'Existing library',
    '新命令': 'New command',
    '请确认': 'Please confirm',
    '使用过': 'Used',
    '已选择': 'Selected',
    '上一页': 'Previous',
    '下一页': 'Next',
    '重启后生效': 'Takes effect after restart',
    '收起': 'Collapse',
    '设置': 'Settings',
    '关闭': 'Close',
    '全部': 'All',
    '置顶': 'Pinned',
    '收藏': 'Favorite',
    '展开': 'Expand',
    '折叠': 'Collapse',
    '名称': 'Name',
    '分类': 'Category',
    '说明': 'Description',
    '粘贴': 'Paste',
    '逐行': 'Line by line',
    '规则': 'Rule',
    '超时': 'Timeout',
    '执行': 'Run',
    '继续': 'Continue',
    '暂停': 'Pause',
    '停止': 'Stop',
    '复制': 'Copy',
    '取消': 'Cancel',
    '保存': 'Save',
    '确认': 'Confirm',
    '新增': 'Add',
    '冲突': 'Conflict',
    '文件': 'File',
    '删除': 'Delete',
    '添加': 'Add',
    '模式': 'Mode',
    '目标': 'Target',
    '内容': 'Content',
    '常用': 'Common',
    '默认': 'Default',
    '日志': 'Logs',
    '全选': 'Select all',
    '命令': 'Command',
    '信息': 'Info',
    '警告': 'Warning',
    '错误': 'Error',
    '源行': 'Source line',
    '耗时': 'Duration',
    '系统': 'System',
    '全屏': 'Full screen',
    '未知': 'Unknown',
    '秒': 's',
}

const orderedEnglishPhrases = Object.entries(englishPhrases)
    .sort(([left], [right]) => right.length - left.length)
const orderedLongEnglishPhrases = orderedEnglishPhrases
    .filter(([source]) => source.length >= 4)

export function translatePluginText (text: string, locale: string | null | undefined): string {
    if (getPluginLanguage(locale) === 'zh-CN' || !/[\u4e00-\u9fff]/.test(text)) {
        return text
    }

    let translated = text
        .replace(/(\d+)\s*条命令，\s*(\d+)\s*条运行日志/g, '$1 commands, $2 runtime logs')
        .replace(/确认永久删除选中的\s*(\d+)\s*条命令？运行日志将保留。/g, 'Permanently delete the selected $1 commands? Runtime logs will be kept.')
        .replace(/将选中的\s*(\d+)\s*条命令移动到/g, 'Move the selected $1 commands to')
        .replace(/默认保留\s*(\d+)\s*条，最多\s*(\d+)\s*条；每页\s*(\d+)\s*条，最新日志在前。/g, 'Keeps $1 entries by default and up to $2; $3 per page, newest first.')
        .replace(/所有会话（\s*(\d+)\s*）/g, 'All sessions ($1)')
        .replace(/该分类中有\s*(\d+)\s*条命令。确认后将同时删除这些命令，此操作无法撤销。/g, 'This category contains $1 commands. Confirming deletes them as well and cannot be undone.')
        .replace(/该分类中没有命令，确认删除该分类？/g, 'This category has no commands. Delete it?')
        .replace(/确认删除“(.+?)”？/g, 'Delete "$1"?')
        .replace(/第\s*(\d+)\s*行执行后暂停，等待继续。/g, 'Source line $1 paused after running and is waiting to continue.')
        .replace(/第\s*(\d+)\s*行的输出规则已停止后续逐行执行。/g, 'Output rules after source line $1 stopped the remaining line-by-line execution.')
        .replace(/查看第\s*(\d+)\s*行的\s*(\d+)\s*条输出规则/g, 'View $2 output rules after source line $1')
        .replace(/为第\s*(\d+)\s*行添加输出规则/g, 'Add an output rule after source line $1')
        .replace(/第\s*(\d+)\s*行执行后：/g, 'After source line $1: ')
        .replace(/第\s*(\d+)\s*行执行后/g, 'After source line $1')
        .replace(/第\s*(\d+)\s*行（当前不可执行）/g, 'Source line $1 (currently not executable)')
        .replace(/第\s*(\d+)\s*行发送失败，需要手动确认后继续。/g, 'Source line $1 failed to send and needs confirmation to continue.')
        .replace(/第\s*(\d+)\s*行发送失败。/g, 'Source line $1 failed to send.')
        .replace(/已发送第\s*(\d+)\s*行。/g, 'Sent source line $1.')
        .replace(/并清理\s*(\d+)\s*个失效触发器引用/g, 'and cleared $1 invalid trigger references')
        .replace(/将“(.+?)”修改为新的分类名称。/g, 'Rename "$1" to a new category name.')
        .replace(/将“(.+?)”移动到指定分类。/g, 'Move "$1" to the selected category.')
        .replace(/执行：命令不存在（(.+?)）/g, 'Run: command does not exist ($1)')
        .replace(/导入文件内快捷键已被“(.+?)”使用/g, 'Shortcut is already used by "$1" inside the import file')
        .replace(/快捷键已被“(.+?)”使用。?/g, 'Shortcut is already used by "$1".')
        .replace(/命令不存在（(.+?)）/g, 'Command does not exist ($1)')
        .replace(/输入\s+(.+?)\s+确认/g, 'Enter $1 to confirm')
        .replace(/(.+?)\s+等\s+(\d+)\s+个会话/g, '$1 and $2 sessions total')
        .replace(/只支持 v3 命令库，当前文件版本为 (.+?)。/g, 'Only v3 command libraries are supported; this file is version $1.')
        .replace(/第\s*(\d+)\s*条命令缺少有效的名称或命令内容。/g, 'Command $1 is missing a valid name or command text.')
        .replace(/第\s*(\d+)\s*条命令格式无效。/g, 'Command $1 has an invalid format.')
        .replace(/(.+?)的第\s*(\d+)\s*条输出触发器字段 (.+?) 无效。/g, '$1 output trigger $2 has an invalid $3 field.')
        .replace(/(.+?)的第\s*(\d+)\s*条输出触发器启用状态无效。/g, '$1 output trigger $2 has an invalid enabled state.')
        .replace(/(.+?)的第\s*(\d+)\s*条输出触发器匹配方式无效。/g, '$1 output trigger $2 has an invalid match mode.')
        .replace(/(.+?)的第\s*(\d+)\s*条输出触发器触发行无效。/g, '$1 output trigger $2 has an invalid trigger line.')
        .replace(/(.+?)的第\s*(\d+)\s*条输出触发器成功条件无效。/g, '$1 output trigger $2 has an invalid success condition.')
        .replace(/(.+?)的第\s*(\d+)\s*条输出触发器错误条件无效。/g, '$1 output trigger $2 has an invalid error condition.')
        .replace(/(.+?)的第\s*(\d+)\s*条输出触发器匹配后动作无效。/g, '$1 output trigger $2 has an invalid post-match action.')
        .replace(/(.+?)的第\s*(\d+)\s*条输出触发器成功动作无效。/g, '$1 output trigger $2 has an invalid success action.')
        .replace(/(.+?)的第\s*(\d+)\s*条输出触发器错误动作无效。/g, '$1 output trigger $2 has an invalid error action.')
        .replace(/(.+?)的第\s*(\d+)\s*条输出触发器超时动作无效。/g, '$1 output trigger $2 has an invalid timeout action.')
        .replace(/(.+?)的第\s*(\d+)\s*条输出触发器格式无效。/g, '$1 output trigger $2 has an invalid format.')
        .replace(/第\s*(\d+)\s*条命令/g, 'Command $1')
        .replace(/(.+?)的第\s*(\d+)\s*条输出触发器/g, '$1 output trigger $2')
        .replace(/(.+?)的输出触发器格式无效。/g, '$1 has an invalid output trigger format.')
        .replace(/(.+?)的逐行延迟格式无效。/g, '$1 has an invalid line delay format.')
        .replace(/(.+?)的逐行暂停格式无效。/g, '$1 has an invalid line pause format.')
        .replace(/(.+?)的字段 (.+?) 无效。/g, '$1 has an invalid $2 field.')
        .replace(/(.+?)的 ID 无效。/g, '$1 has an invalid ID.')
        .replace(/(.+?)不是有效对象。/g, '$1 is not a valid object.')
        .replace(/(.+?)缺少有效名称。/g, '$1 is missing a valid name.')
        .replace(/(.+?)缺少命令内容字段。/g, '$1 is missing the command text field.')
        .replace(/导入文件包含重复命令 ID：(.+?)。/g, 'The import file contains duplicate command ID $1.')
        .replace(/导入文件内名称已被“(.+?)”使用/g, 'Name is already used by "$1" inside the import file')
        .replace(/导入文件内快捷键已被“(.+?)”使用/g, 'Shortcut is already used by "$1" inside the import file')
        .replace(/名称已存在于“(.+?)”分类/g, 'Name already exists in category "$1"')
        .replace(/命令库缺少 (.+?) 数组。/g, 'The command library is missing the $1 array.')
        .replace(/命令库字段 (.+?) 包含无效值。/g, 'Command library field $1 contains an invalid value.')
        .replace(/切换到标签\s*(\d+)/g, 'Switch to tab $1')

    for (const [source, target] of orderedLongEnglishPhrases) {
        translated = translated.split(source).join(target)
    }

    translated = translated
        .replace(/第\s*(\d+)\s*\/\s*(\d+)\s*页/g, 'Page $1 / $2')
        .replace(/第\s*(\d+)\s*页/g, 'Page $1')
        .replace(/第\s*(\d+)\s*行/g, 'Source line $1')
        .replace(/第\s*(\d+)\s*\/\s*(\d+)\s*步/g, 'Step $1 / $2')
        .replace(/(\d+)\s*条命令/g, '$1 commands')
        .replace(/(\d+)\s*条运行日志/g, '$1 runtime logs')
        .replace(/(\d+)\s*条自动化规则/g, '$1 automation rules')
        .replace(/(\d+)\s*条/g, '$1 entries')
        .replace(/(\d+)\s*行/g, '$1 lines')
        .replace(/(\d+)\s*个会话/g, '$1 sessions')

    for (const [source, target] of orderedEnglishPhrases) {
        translated = translated.split(source).join(target)
    }

    return translated
        .replace(/目标：/g, 'Targets: ')
        .replace(/，/g, ', ')
        .replace(/。/g, '.')
        .replace(/；/g, '; ')
        .replace(/：/g, ': ')
        .replace(/？/g, '?')
        .replace(/（/g, ' (')
        .replace(/）/g, ')')
}
