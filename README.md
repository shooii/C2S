# C2S CIM to SIM

C2S 是一个 CIM 数据到 SIM 具身智能训练数据的转换平台。当前 MVP 包含两个一级模块：

- 模板管理：上传 `.fmw` / `.fmwt`，解析 Published Parameters / User Parameters，配置参数并发起转换。
- 成果管理：查看 FME 转换任务、运行日志、输出文件、下载入口和在线预览。

后端不是纯 Mock。用户发起转换后，系统会通过 Node.js `child_process.spawn(command, args)` 调用本机 FME Form，运行日志来自 FME stdout / stderr，成果来自 `backend/storage/outputs/{taskId}/`。

## 技术栈

- 前端：React、TypeScript、Vite、Ant Design、Three.js、Cesium
- 后端：Node.js、Express、TypeScript、SQLite
- 本地 FME：优先调用 `fme.exe`，失败后调用 `C:\Program Files\FME\fme.exe`

## 环境要求

- Node.js 24 或更高版本。本项目使用 Node 内置 `node:sqlite`，无需安装原生 SQLite npm 包。
- Windows 本机已安装 FME Form，并建议将 `C:\Program Files\FME` 加入系统环境变量。

## 目录结构

```text
c2s-platform/
├── frontend/
│   └── src/
│       ├── pages/
│       │   ├── TemplateManage/
│       │   ├── ResultManage/
│       │   └── Preview/
│       ├── components/
│       ├── services/
│       ├── types/
│       └── App.tsx
├── backend/
│   ├── src/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── db/
│   │   ├── config/
│   │   └── server.ts
│   └── storage/
│       ├── templates/
│       ├── input/
│       ├── outputs/
│       ├── logs/
│       └── data/
└── README.md
```

## 安装依赖

在项目根目录执行：

```powershell
cd c2s-platform
npm install
```

项目使用 Node 内置 SQLite，不依赖需要 C++ 编译的原生 SQLite npm 包。

## 初始化数据库

```powershell
npm run init:db
```

数据库文件位置：

```text
backend/storage/data/c2s.sqlite
```

初始化 SQL 文件：

```text
backend/src/db/schema.sql
```

## 启动后端

```powershell
npm run dev -w backend
```

默认地址：

```text
http://localhost:4000
```

## 启动前端

另开一个终端：

```powershell
npm run dev -w frontend
```

默认地址：

```text
http://localhost:5173
```

也可以在根目录同时启动：

```powershell
npm run dev
```

## 检查 FME 是否可用

命令行检查：

```powershell
fme.exe --version
```

如果环境变量不可用，再检查完整路径：

```powershell
& "C:\Program Files\FME\fme.exe" --version
```

后端接口检查：

```powershell
Invoke-RestMethod http://localhost:4000/api/fme/status
```

## 上传 .fmw / .fmwt

1. 打开前端 `http://localhost:5173`
2. 进入“模板管理”
3. 点击“上传模板”
4. 选择 `.fmw` 或 `.fmwt`
5. 后端保存文件到 `backend/storage/templates/`
6. 后端解析模板参数并写入 SQLite

模板接口：

```text
POST   /api/templates/upload
GET    /api/templates
GET    /api/templates/:id
POST   /api/templates/:id/parse
DELETE /api/templates/:id
```

## 运行转换任务

1. 在“模板管理”选择模板，点击“配置”或“运行”
2. 填写任务名称
3. 选择输入 CIM 数据文件
4. 选择输出格式
5. 根据模板参数填写动态表单
6. 点击“发起转换”

后端会：

- 创建任务记录
- 创建输出目录 `backend/storage/outputs/{taskId}/`
- 创建日志文件 `backend/storage/logs/{taskId}.log`
- 使用 `spawn` 执行 FME
- 以参数数组方式传参，支持 Windows 空格路径
- 扫描输出目录并生成成果文件记录

FME 参数形式：

```text
fme.exe "C:\path\to\template.fmw" --PARAM_NAME "paramValue" --OUTPUT_DIR "C:\path\to\output"
```

实现中不会把整条命令拼成字符串执行，而是构造：

```ts
spawn(command, [workspacePath, "--PARAM_NAME", "paramValue", "--OUTPUT_DIR", outputPath])
```

任务接口：

```text
POST /api/tasks/run
GET  /api/tasks
GET  /api/tasks/:id
GET  /api/tasks/:id/logs
POST /api/tasks/:id/cancel
POST /api/tasks/:id/rerun
```

## 下载和预览成果

成果接口：

```text
GET    /api/results/:taskId/files
GET    /api/results/:taskId/download/:fileId
GET    /api/results/:taskId/preview
DELETE /api/results/:taskId
```

预览策略：

- `.glb` / `.gltf`：Three.js 预览
- `tileset.json` / 3D Tiles 内容：Cesium 预览
- `.json`：结构化 JSON 面板
- 其他文件：显示暂不支持在线预览

下载接口会校验文件路径必须位于对应任务的输出目录中，避免任意文件下载。

## 数据表

项目初始化以下表：

- `templates`
- `template_parameters`
- `conversion_tasks`
- `result_files`

字段定义见：

```text
backend/src/db/schema.sql
```

## 常见错误排查

### FME 未就绪

现象：页面顶部显示“FME 未就绪”，任务直接失败。

处理：

```powershell
fme.exe --version
& "C:\Program Files\FME\fme.exe" --version
```

确认 FME Form 已安装，并且系统环境变量包含 FME 安装目录。

### 模板上传失败

只允许 `.fmw` / `.fmwt`。如果文件名包含特殊字符，后端会保存为安全文件名。

### 模板参数未识别

后端会优先检查 FME 可用性，并对 `.fmw` 文本或 `.fmwt` 内部 `.fmw` 做参数解析。不同 FME 版本和模板写法可能存在差异；如果解析不到参数，仍可运行模板，但需要在前端手动配置模板所需的参数名。

### Windows 路径包含空格

FME 执行使用 `spawn(command, args)`，路径作为数组参数传递，不需要手动添加引号。

### 转换失败但没有成果

查看：

```text
backend/storage/logs/{taskId}.log
```

同时在“成果管理”中打开任务详情查看 stdout / stderr。

### 成果无法预览

确认输出目录中存在以下文件类型之一：

- `.glb`
- `.gltf`
- `tileset.json`
- `.json`

其他格式可以下载后使用专业工具查看。
