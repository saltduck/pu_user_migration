# ParaLuni 用户资产迁移脚本

## 1. 概述

这是一个为 ParaLuni 用户设计的资产迁移脚本，旨在帮助用户将其在**旧版** MasterChef 和 SousChef 合约中的资产（包括质押的代币、LP 代币和 VIP 门票）无缝、安全地迁移至**新版**合约。

该脚本专为浏览器环境设计，可轻松集成到任何前端项目中，并通过 MetaMask 等浏览器钱包插件与用户账户进行交互。

### 主要特性

- **安全性**: 脚本的每一步操作都经过精心设计，以确保资金安全。
- **可恢复性**: 利用浏览器的本地存储（LocalStorage），迁移过程可以在意外中断（如刷新页面或网络断开）后，从上一个成功完成的步骤自动恢复，有效防止了重复提款等意外情况。
- **高效率**: 所有的 SousChef 奖励都会在资金迁移全部完成后，通过一次性的批量交易（`claim`）进行领取，以最大程度地为用户节省 Gas 费用。
- **清晰的日志**: 脚本在执行的每个关键步骤都会在控制台输出清晰的日志，方便开发者集成和调试，也便于向用户展示迁移进度。

## 2. 安装

```bash
npm install paraluni-user-migration
```
*（注意：这是一个示例包名，请根据实际情况修改。）*

## 3. 使用示例

以下是一个在网页中调用此迁移脚本的完整示例。开发者需要一个现代化的前端构建工具（如 Vite, Webpack）来处理模块导入。

### 3.1. HTML 页面 (`index.html`)

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>ParaLuni 资产迁移</title>
    <style>
        body { font-family: sans-serif; padding: 2em; }
        button { font-size: 1em; padding: 0.5em 1em; margin-top: 1em; }
        #logs { margin-top: 1em; border: 1px solid #ccc; padding: 1em; height: 300px; overflow-y: scroll; white-space: pre-wrap; }
    </style>
</head>
<body>
    <h1>ParaLuni 资产迁移</h1>
    <p>请先连接您的钱包，然后开始迁移。</p>
    <button id="connectButton">连接钱包</button>
    <button id="migrateButton" disabled>开始迁移</button>
    <h3>迁移日志:</h3>
    <div id="logs"></div>

    <script type="module" src="/src/app.js"></script>
</body>
</html>
```

### 3.2. JavaScript 逻辑 (`src/app.js`)

```javascript
import { ethers } from 'ethers';
// 从你的项目中导入迁移脚本
import { migrateAll } from 'paraluni-user-migration';

// --- 获取页面元素 ---
const connectButton = document.getElementById('connectButton');
const migrateButton = document.getElementById('migrateButton');
const logDiv = document.getElementById('logs');

let signer = null;

// --- 日志输出 ---
const log = (message) => {
    console.log(message); // 仍然在控制台输出
    logDiv.innerHTML += `> ${message}\n`;
    logDiv.scrollTop = logDiv.scrollHeight; // 自动滚动到底部
};

// 重写 console.log/warn/error，使其能同时输出到页面上
console.log = (message) => log(`[LOG] ${message}`);
console.error = (message) => log(`[ERROR] ${message}`);
console.warn = (message) => log(`[WARN] ${message}`);

// --- 钱包连接逻辑 ---
connectButton.addEventListener('click', async () => {
    if (typeof window.ethereum === 'undefined') {
        return console.error('MetaMask 未安装，请先安装浏览器钱包插件。');
    }
    try {
        const provider = new ethers.BrowserProvider(window.ethereum);
        signer = await provider.getSigner();
        const address = await signer.getAddress();
        
        console.log(`钱包已连接: ${address}`);
        connectButton.textContent = `已连接: ${address.substring(0, 6)}...`;
        connectButton.disabled = true;
        migrateButton.disabled = false;
    } catch (e) {
        console.error(`钱包连接失败: ${e.message}`);
    }
});

// --- 迁移执行逻辑 ---
migrateButton.addEventListener('click', async () => {
    if (!signer) {
        return console.error('请先连接钱包。');
    }
    
    migrateButton.disabled = true;
    migrateButton.textContent = '正在迁移中...';

    try {
        await migrateAll(signer);
        console.log('🎉 恭喜！所有资产已成功迁移！');
    } catch (error) {
        console.error(`迁移过程中发生严重错误: ${error.message}`);
    } finally {
        migrateButton.disabled = false;
        migrateButton.textContent = '开始迁移';
    }
});
```

## 4. API 参考

该库主要导出以下三个异步函数：

### `migrateAll(signer)`
这是推荐使用的主要函数。它会按顺序自动完成所有迁移任务。
- **参数**:
    - `signer`: 一个 `ethers.js` 的 `Signer` 对象，用于签名和发送交易。必须从用户的浏览器钱包中获取。
- **执行流程**:
    1.  内部先调用 `migrateMasterChef(signer)`。
    2.  然后调用 `migrateSousChef(signer)`。

### `migrateMasterChef(signer)`
仅迁移用户在旧 MasterChef 合约中的资产。
- **参数**:
    - `signer`: 一个 `ethers.js` 的 `Signer` 对象。
- **功能**:
    - 提取所有池子中质押的 LP 代币。
    - 提取 VIP 池中的门票（Tickets）。
    - 将提取出的 LP 代币和门票存入新的 MasterChef 合约。

### `migrateSousChef(signer)`
仅迁移用户在旧 SousChef 合约中的资产并领取奖励。
- **参数**:
    - `signer`: 一个 `ethers.js` 的 `Signer` 对象。
- **功能**:
    - 提取所有池子中质押的代币，并存入新的 SousChef 合约。
    - 在所有资金迁移完成后，将所有池子的待领奖励通过一笔交易批量领取。

## 5. 核心逻辑详解

### 可恢复的迁移流程

为了防止用户因刷新页面或网络问题而导致资金损失，迁移脚本为每个池子（PID）的迁移都设计了原子化的步骤，并利用 `localStorage` 记录关键状态。

以 SousChef 的迁移为例，对于每个池子，完整的流程是：

1.  **检查本地状态**: 脚本会先检查 `localStorage` 中是否存在 `migration_souschef_{user_address}_pid_{pid}` 这样的记录。
2.  **提款 (Withdraw)**:
    -   如果**不存在**本地记录，脚本会从旧合约中**提款**。
    -   提款成功后，脚本会从交易事件日志中精确地解析出实际到账的代币数量。
    -   **关键步骤**: 脚本会立刻将“已提款，待存款”的状态（包括代币地址和数量）写入 `localStorage`。
3.  **存款 (Deposit)**:
    -   如果**存在**本地记录（无论是上一步写入的，还是页面刷新后重新读取的），脚本会执行**存款**操作，将代币存入新合约。
4.  **清理状态**: 存款成功后，脚本会从 `localStorage` 中**删除**该池子的记录。
5.  **计算奖励**: 在该池子的资金迁移完成后，计算其最终可领取的奖励，并将其加入到待领取的队列中。

通过这种机制，即使用户在第 2 步和第 3 步之间中断了操作，下次运行时脚本也能安全地从第 3 步继续，而不会重复执行提款。
