# 用户迁移脚本：需求与设计文档

## 1. 概述

本文档详细描述了 `user-migration` 脚本的设计与实现，该脚本旨在帮助用户将其在旧版 ParaLuni 协议中的资产（包括 MasterChef 和 SousChef 中的质押代币及奖励）无缝迁移至新版协议。

脚本的核心设计目标是**安全性**、**原子性**和**可恢复性**。通过利用浏览器的本地存储（LocalStorage），脚本能够在意外中断（如关闭浏览器或网络问题）后，从上一个成功完成的步骤继续执行，避免了重复提款等潜在风险。

## 2. 核心组件

### 2.1. 合约地址

脚本与以下四个核心智能合约进行交互：

- **旧 MasterChef**: `0x77341bF31472E9c896f36F4a448fdf573A0D9B60`
- **新 MasterChef**: `0x192923A619FC6Abf1c17fEbC0d9d1C9bEE3a02a5`
- **旧 SousChef**: `0x9F68bcE058901D3583A122889BE27a4D2f55b656`
- **新 SousChef**: `0x26A6320Ca85EE981dCf39Ad77A87EDFF464f00DF`

### 2.2. ABI

脚本��用了两个 ABI 定义：

- `MASTERCHEF_ABI`: 用于与新、旧 MasterChef 合约交互。
- `SOUSCHEF_ABI`: 用于与新、旧 SousChef 合约交互。

### 2.3. 辅助函数

- `withRetries()`: 一个包装函数，用于执行只读的合约调用。当调用失败时，它会自动重试最多 3 次，以提高在网络波动情况下的稳定性。
- `sendTransaction()`: 一个健壮的交易发送函数。它会等待交易被矿工打包并确认，同时检查交易状态。如果交易失败（reverted），它会抛出错误，中断执行。
- `localStorage` 帮手函数 (`get/set/clearPendingMigration`): 这些函数用于在本地存储中安全地创建、读取和删除迁移状态，是实现可恢复性的关键。

## 3. 迁移流程

### 3.1. MasterChef 迁移 (`migrateMasterChef`)

此函数负责迁移用户在旧 MasterChef 合约中的 LP 代币和 VIP 池门票。

**执行步骤**:

1.  **遍历池子**: 脚本会从 PID 0 开始，遍历所有 MasterChef 池。
2.  **状态检查**: 在处理每个池子前，首先检查本地存储中是否存在该 PID 的待处理迁移记录。
    -   **如果存在**: 说明之前的迁移在提款后、存款前中断。脚本会直接使用本地记录的 `lpTokenAddress` 和 `amountToDeposit`，跳过提款步骤，直接进入存款流程。
    -   **如果不存在**: 继续执行下一步。
3.  **提款 (Withdraw)**:
    -   检查用户在该池子中的质押数量 (`userInfo.amount`)。
    -   如果用户有质押，则调用旧 MasterChef 的 `withdraw` 函数提取所有 LP 代币。
    -   **从事件中获取数量**: 交易成功后，脚本会从返回的收据中解析 `Withdraw` 事件，以获取**实际到账**的 LP 代币数量。这是确保数据准确性的关键。
    -   **保存状态**: 在存款前，将 `lpTokenAddress` 和刚获取的 `amountToDeposit` 存入本地存储。
4.  **VIP 门票迁移**: 如果池子是 VIP 池 (`pooltype == 1`)，脚本会：
    -   从旧合约中提取所有已质押的门票 (`withdraw_tickets`)。
    -   将这些门票存入新合约 (`deposit_all_tickets`)。
5.  **存款 (Deposit)**:
    -   调用 LP 代币合约的 `approve` 方法，授权新 MasterChef 合约使用相应数量的代币。
    -   调用新 MasterChef 的 `deposit` 方法，将代币���入对应的池子。
6.  **清理状态**: 存款成功后，清除本地存储中该 PID 的迁移记录。

### 3.2. SousChef 迁移 (`migrateSousChef`)

此函数负责迁移用户在旧 SousChef 合约中的质押代币，并在所有资金迁移完成后，一次性领取所有奖励。

**执行步骤**:

1.  **遍历池子**: 脚本从 PID 0 开始，遍历所有 SousChef 池。
2.  **状态检查**: 与 MasterChef 逻辑类似，首先检查本地存储中是否存在该 PID 的待处理迁移记录。
    -   **如果存在**: 直接使用本地记录的 `tokenAddress` 和 `amountToDeposit`，跳到存款步骤。
    -   **如果不存在**: 继续执行下一步。
3.  **提款 (Withdraw)**:
    -   检查用户在该池子中的质押数量 (`userPools.deposit`)。
    -   如果是底池（poolType=4），首先检查当前时间是否达到userNoFeeTime，没达到则不提款。
    -   如果数量大于 0，则调用旧 SousChef 的 `withdraw` 函数。参数设置如下：
        -   `regularIds`: 如果 `poolType` 为 `1`，则通过 `getUserPoolRegular()` 获取；否则传空数组 `[]`。
        -   `isLp`: 始终为 `false`。
        -   `isWETH`: 始终为 `false`。
    -   **从事件中获取数量**: 交易成功后，从 `Withdraw` 事件中精确获取实际到账的代币数量。
    -   **保存状态**: 将 `tokenAddress` 和获取到的 `amountToDeposit` 存入本地存储。
4.  **存款 (Deposit)**:
    -   如果 `amountToDeposit` 大于 0，则执行存款操作。
    -   **特殊处理**: 对于22号池，存款时不存入22号池，而是改存入54号池。
    -   调用代币合约的 `approve` 方法，授权新 SousChef 合约。
    -   调用新 SousChef 的 `deposit` 方法，存入代币。`tokens` 和 `amountsForLp` 参数均按要求设置为空值 (`[ethers.constants.AddressZero, ethers.constants.AddressZero], [0, 0]`)。
5.  **计算并暂存奖励**:
    -   在**资金迁移完成之后**，脚本会再次调用旧 SousChef 的 `pendingV42()` 和 `userPools()`，计算该池子最终可领取的奖励总额 (`pendingV42 + userPool.reward`)。
    -   如果奖励大于 0，则将该 `pid` 和 `totalRewardsToClaim` 分别存入 `pidsToClaim` 和 `amountsToClaim` 数组中，等待最后统一领取。
6.  **清理状态**: 成功处理完一个池子后（包括存款和奖励计算），清除本地存储中对应的记录。

### 3.3. 批量领取奖励 (Claim)

- **触发时机**: 在 `migrateSousChef` 函数的循环全部结束后执行。
- **���行逻辑**:
    -   检查 `pidsToClaim` 数组是否为空。
    -   如果不为空，则调用**旧 SousChef** 的 `claim` 函数，一次性发起交易。
    -   `pids`: `pidsToClaim` 数组。
    -   `amounts`: `amountsToClaim` 数组。
    -   `lpPid`: 固定值为 `22`。
    -   `to`: 用户自己的地址。

## 4. 主执行函数 (`migrateAll`)

这是用户最终调用的入口函数。它会按顺序依次执行：

1.  `migrateMasterChef(signer)`
2.  `migrateSousChef(signer)`

确保了 MasterChef 的迁移总是在 SousChef 之前完成。
