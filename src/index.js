

// Description: User migration script for ParaLuni
// Author: hsn
// Date: 2024-07-29

const { ethers } = require("ethers");
const { MASTERCHEF_ABI, SOUSCHEF_ABI } = require("./abi.js");

// --- Contract Addresses ---
const OLD_MASTERCHEF_ADDRESS = "0x77341bF31472E9c896f36F4a448fdf573A0D9B60";
const NEW_MASTERCHEF_ADDRESS = "0x192923A619FC6Abf1c17fEbC0d9d1C9bEE3a02a5";
const OLD_SOUSCHEF_ADDRESS = "0x9F68bcE058901D3583A122889BE27a4D2f55b656";
const NEW_SOUSCHEF_ADDRESS = "0x26A6320Ca85EE981dCf39Ad77A87EDFF464f00DF";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) public returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const IParaPair_ABI = [
  "function getReserves() external view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)"
];

// --- LocalStorage Persistence Helpers ---
const getStorageKey = (user, pid, type = "masterchef") => `migration_${type}_${user}_pid_${pid}`;

const getPending = (user, pid, type = "masterchef") => {
  try {
    if (typeof localStorage === 'undefined') return null;
    const pending = localStorage.getItem(getStorageKey(user, pid, type));
    return pending ? JSON.parse(pending) : null;
  } catch (e) {
    console.error("Could not read from localStorage", e);
    return null;
  }
};

const setPending = (user, pid, data, type = "masterchef") => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(getStorageKey(user, pid, type), JSON.stringify(data));
  } catch (e) {
    console.error("Could not write to localStorage", e);
  }
};

const clearPending = (user, pid, type = "masterchef") => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(getStorageKey(user, pid, type));
  } catch (e) {
    console.error("Could not remove from localStorage", e);
  }
};

const toObject = (obj) => {
  return JSON.parse(JSON.stringify(obj, (key, value) =>
      typeof value === 'bigint'
          ? value.toString()
          : value // return everything else unchanged
  ));
}

// --- Helper for retrying failed read-only calls ---
async function retry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      console.warn(`Operation failed, retrying... (Attempt ${i + 1}/${retries})`);
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

// --- Helper for robust transaction handling ---
async function send(txFunction) {
  const tx = await txFunction();
  const receipt = await tx.wait();
  if (receipt.status === 0) {
    throw new Error(`Transaction failed (reverted). TX: ${tx.hash}`);
  }
  return receipt;
}

async function migrateMC(signer) {
  const oldMasterChef = new ethers.Contract(OLD_MASTERCHEF_ADDRESS, MASTERCHEF_ABI, signer);
  const newMasterChef = new ethers.Contract(NEW_MASTERCHEF_ADDRESS, MASTERCHEF_ABI, signer);
  const userAddress = await signer.getAddress();

  console.log(`Starting MasterChef migration for user: ${userAddress}...`);

  let poolLength;
  try {
    poolLength = await retry(() => oldMasterChef.poolLength());
    console.log(`Found ${poolLength} pools in the old MasterChef.`);
  } catch (error) {
    console.error("Fatal: Could not fetch pool length. Aborting.", error);
    return;
  }

  for (let pid = 0; pid < poolLength; pid++) {
    try {
      console.log(`--- Processing MasterChef PID ${pid} ---`);
      const pending = getPending(userAddress, pid, "masterchef");

      let lpTokenAddress, amountToDeposit;
      const poolInfo = await retry(() => oldMasterChef.poolInfo(pid));
      const isVipPool = poolInfo.pooltype.toString() === '1';

      if (pending) {
        console.log(`PID ${pid}: Found pending migration in localStorage. Recovering...`);
        lpTokenAddress = pending.lpTokenAddress;
        amountToDeposit = BigInt(pending.amount);
      } else {
        const userInfo = await retry(() => oldMasterChef.userInfo(pid, userAddress));
        const stakedAmount = userInfo.amount;
        const hasStakedLp = stakedAmount > 0n;

        if (!hasStakedLp && !isVipPool) {
          console.log(`PID ${pid}: No funds or VIP tickets to migrate. Skipping.`);
          continue;
        }

        if (hasStakedLp) {
          const receipt = await send(
            () => oldMasterChef.withdraw(pid, stakedAmount)
          );
          
          // Debug: Log all events to understand the structure
          // console.log(`PID ${pid}: Transaction receipt:`, toObject(receipt));
          console.log(`PID ${pid}: Transaction receipt events:`, receipt.events?.map(e => ({ name: e.event, args: e.args })));
          
          // Try to find Withdraw event with more flexible matching
          let event = receipt.events?.find(e => e.event === 'Withdraw' && e.args.pid == pid);
          
          // If not found, try alternative event names or structures
          if (!event) {
            event = receipt.events?.find(e => e.event === 'Withdraw');
          }
          
          if (!event) {
            event = receipt.events?.find(e => e.event && e.event.toLowerCase().includes('withdraw'));
          }
          
          if (!event) {
            console.warn(`PID ${pid}: Could not find Withdraw event. Available events:`, receipt.events?.map(e => e.event));
            // Fallback: use the staked amount * 99.5% as the amount to deposit (accounting for potential fees)
            amountToDeposit = stakedAmount * 995n / 1000n;
            lpTokenAddress = poolInfo.lpToken;
            console.log(`PID ${pid}: Using staked amount * 99.5% as fallback: ${ethers.formatUnits(amountToDeposit)}`);
          } else {
            amountToDeposit = event.args.amount;
            lpTokenAddress = poolInfo.lpToken;
            console.log(`PID ${pid}: Found event: ${event.event}, amount: ${ethers.formatUnits(amountToDeposit)}`);
          }

          setPending(userAddress, pid, { lpTokenAddress, amount: amountToDeposit.toString() }, "masterchef");
          console.log(`PID ${pid}: Withdrawal complete. Saved state to localStorage.`);
        }
      }

      // Migrate Tickets for VIP pools
      if (isVipPool) {
        const ticketAddress = poolInfo.ticket;
        const stakedTickets = await retry(() => oldMasterChef.ticket_staked_array(userAddress, ticketAddress));
        if (stakedTickets.length > 0) {
          console.log(`PID ${pid}: Migrating ${stakedTickets.length} tickets...`);
          for (const tokenId of stakedTickets) {
            await send(() => oldMasterChef.withdraw_tickets(pid, tokenId));
          }
        }

                  const ticketContract = new ethers.Contract(ticketAddress, [
            "function tokensOfOwner(address owner) public view returns (uint256[])",
            "function setApprovalForAll(address operator, bool approved) public",
            "function approve(address to, uint256 tokenId) public",
            "function isApprovedForAll(address owner, address operator) public view returns (bool)",
            "function getApproved(uint256 tokenId) public view returns (address)"
          ], signer);
        // 获取钱包中的ticket列表
          const myTickets = await retry(() => ticketContract.tokensOfOwner(userAddress));
          if (myTickets.length > 0) {
            // Check if new MasterChef is already approved for all tickets
            const isApprovedForAll = await retry(() => ticketContract.isApprovedForAll(userAddress, NEW_MASTERCHEF_ADDRESS));
            
            if (!isApprovedForAll) {
              console.log(`PID ${pid}: New MasterChef not approved for all tickets, checking individual approvals...`);
              
              // Check which tokens need individual approval
              const tokensNeedingApproval = [];
              for (const tokenId of myTickets) {
                const approvedAddress = await retry(() => ticketContract.getApproved(tokenId));
                if (approvedAddress !== NEW_MASTERCHEF_ADDRESS) {
                  tokensNeedingApproval.push(tokenId);
                }
              }
              
              if (tokensNeedingApproval.length > 0) {
                console.log(`PID ${pid}: ${tokensNeedingApproval.length} tokens need approval`);
                
                // First try setApprovalForAll (for ERC721)
                try {
                  await send(() => ticketContract.setApprovalForAll(NEW_MASTERCHEF_ADDRESS, true));
                  console.log(`PID ${pid}: Approved new MasterChef for all ticket transfers`);
                } catch (error) {
                  console.log(`PID ${pid}: setApprovalForAll failed, trying individual approvals...`);
                  // If setApprovalForAll fails, try individual approvals
                  for (const tokenId of tokensNeedingApproval) {
                    try {
                      await send(() => ticketContract.approve(NEW_MASTERCHEF_ADDRESS, tokenId));
                      console.log(`PID ${pid}: Approved token ${tokenId} for new MasterChef`);
                    } catch (approvalError) {
                      console.warn(`PID ${pid}: Failed to approve token ${tokenId}:`, approvalError.message);
                    }
                  }
                }
              } else {
                console.log(`PID ${pid}: All tokens already approved for new MasterChef`);
              }
            } else {
              console.log(`PID ${pid}: New MasterChef already approved for all tickets`);
            }
          
          await send(() => newMasterChef.deposit_all_tickets(ticketAddress));
        }
      }

      // Deposit LP to new MasterChef
      if (amountToDeposit && amountToDeposit > 0n) {
        // Check if pool is active (allocPoint > 0)
        const poolInfo = await retry(() => newMasterChef.poolInfo(pid));
        if (poolInfo.allocPoint.toString() === '0') {
          console.log(`PID ${pid}: Pool allocPoint is 0, skipping deposit to new MasterChef`);
        } else {
          const lpTokenContract = new ethers.Contract(lpTokenAddress, ERC20_ABI, signer);
          
          // Check wallet balance before deposit
          const walletBalance = await retry(() => lpTokenContract.balanceOf(userAddress));
          const actualDepositAmount = walletBalance < amountToDeposit ? walletBalance : amountToDeposit;
          
          if (actualDepositAmount <= 1n) {
            console.log(`PID ${pid}: Wallet balance is <= 1, skipping deposit to new MasterChef`);
            continue;
          }
          
          console.log(`PID ${pid}: Wallet balance: ${ethers.formatUnits(walletBalance)}, intended deposit: ${ethers.formatUnits(amountToDeposit)}, actual deposit: ${ethers.formatUnits(actualDepositAmount)}`);
          
          // Check current allowance
          const currentAllowance = await retry(() => lpTokenContract.allowance(userAddress, NEW_MASTERCHEF_ADDRESS));
          if (currentAllowance < actualDepositAmount) {
            console.log(`PID ${pid}: Current allowance ${ethers.formatUnits(currentAllowance)} is insufficient, approving...`);
            await send(
              () => lpTokenContract.approve(NEW_MASTERCHEF_ADDRESS, ethers.MaxUint256)
            );
          } else {
            console.log(`PID ${pid}: Current allowance ${ethers.formatUnits(currentAllowance)} is sufficient, skipping approve`);
          }
          
          await send(
            () => newMasterChef.deposit(pid, actualDepositAmount)
          );
        }
      }

      clearPending(userAddress, pid, "masterchef");
      console.log(`PID ${pid}: Migration for this pool completed successfully! State cleared.`);

    } catch (error) {
      console.error(`PID ${pid}: MasterChef migration for this pool FAILED. Details:`, error.message || error);
      console.log(`Please try again. The script will attempt to recover from the last successful step.`);
    }
  }

  console.log("--- MasterChef migration process finished. ---");
}

async function migrateSC(signer) {
  const oldSousChef = new ethers.Contract(OLD_SOUSCHEF_ADDRESS, SOUSCHEF_ABI, signer);
  const newSousChef = new ethers.Contract(NEW_SOUSCHEF_ADDRESS, SOUSCHEF_ABI, signer);
  const userAddress = await signer.getAddress();

  console.log(`Starting SousChef migration for user: ${userAddress}...`);

  let poolLength;
  try {
    poolLength = await retry(() => oldSousChef.poolLength());
    console.log(`Found ${poolLength} pools in the old SousChef.`);
  } catch (error) {
    console.error("Fatal: Could not fetch SousChef pool length. Aborting.", error);
    return;
  }

  const pidsToClaim = [];
  const amountsToClaim = [];

  for (let pid = 0; pid < poolLength; pid++) {
    try {
      console.log(`--- Processing SousChef PID ${pid} ---`);
      const pending = getPending(userAddress, pid, "souschef");
      
      let tokenAddress, amountToDeposit;

      if (pending) {
        console.log(`PID ${pid}: Found pending migration in localStorage. Recovering...`);
        tokenAddress = pending.tokenAddress;
        amountToDeposit = BigInt(pending.amount);
      } else {
        const userPoolInfo = await retry(() => oldSousChef.userPools(userAddress, pid));
        const stakedAmount = userPoolInfo.deposit;

        const poolInfo = await retry(() => oldSousChef.pools(pid));

        // Maturity check for poolType 4 or 7
        if ((poolInfo.poolType.toString() === '4' || poolInfo.poolType.toString() === '7')) {
          const userNoFeeTime = await retry(() => oldSousChef.userNoFeeTime(userAddress, pid));
          const currentTimestamp = await retry(() => signer.provider.getBlock('latest').then(block => block.timestamp));
          const redemptionDelay = poolInfo.redemptionDelay; // Assuming poolInfo has redemptionDelay

          const canWithdraw = BigInt(userNoFeeTime) <= BigInt(currentTimestamp);
          // console.log(`PID ${pid}: userNoFeeTime: ${userNoFeeTime}, currentTimestamp: ${currentTimestamp}, redemptionDelay: ${redemptionDelay}, Can Withdraw: ${canWithdraw}`);
          if (!canWithdraw) {
            console.log(`PID ${pid}: Pool type is ${poolInfo.poolType}, but maturity is not 100%. Skipping withdrawal.`);
            continue; // Skip withdrawal if not 100% mature
          }
        }

        if (stakedAmount > 0n) {
          console.log(`PID ${pid}: Staked amount is ${ethers.formatUnits(stakedAmount)}. Starting withdrawal...`);
          const poolInfo = await retry(() => oldSousChef.pools(pid));
          
          let regularIds = [];
          if (poolInfo.poolType.toString() === '1') {
            try {
              // getUserPoolRegular takes (addr, pid) parameters
              const userPoolRegular = await retry(() => oldSousChef.getUserPoolRegular(userAddress, pid));
              console.log(`PID ${pid}: getUserPoolRegular result:`, userPoolRegular);
              
              // Handle different return types from getUserPoolRegular
              console.log(`PID ${pid}: userPoolRegular type:`, typeof userPoolRegular, 'isArray:', Array.isArray(userPoolRegular));
              
              // Convert to string first to handle ethers.js wrapper objects
              const userPoolRegularStr = userPoolRegular.toString();
              console.log(`PID ${pid}: userPoolRegular as string:`, userPoolRegularStr);
              
              if (userPoolRegularStr.includes(',')) {
                // If it's a comma-separated string, split and process
                const stringIds = userPoolRegularStr.split(',').map(s => s.trim());
                regularIds = stringIds.map((id, index) => {
                  // Handle very large numbers by using BigInt
                  try {
                    const bigId = BigInt(id);
                    // Extract the index (i) from the composite value
                    // infoRegular[i] = i + regular.redemptionStart * 1e10 + regular.redemptionEnd * 1e20 + regular.amount * 1e40;
                    // The index is the remainder when divided by 1e10
                    const extractedIndex = Number(bigId % BigInt(1e10));
                    console.log(`PID ${pid}: Extracted index ${extractedIndex} from composite value ${id}`);
                    return extractedIndex;
                  } catch (e) {
                    console.warn(`PID ${pid}: Invalid number in regularIds:`, id);
                    return 0;
                  }
                }).filter(id => id !== 0);
                console.log(`PID ${pid}: Processed regularIds from string:`, regularIds);
              } else if (Array.isArray(userPoolRegular)) {
                // If it's already an array, process it
                regularIds = userPoolRegular.map(id => {
                  const numId = typeof id === 'object' && id.toString ? id.toString() : id;
                  return parseInt(numId, 10);
                }).filter(id => !isNaN(id));
                console.log(`PID ${pid}: Processed regularIds from array:`, regularIds);
              } else {
                console.warn(`PID ${pid}: getUserPoolRegular returned unexpected format:`, userPoolRegular);
                regularIds = [];
              }
              
              // Filter regularIds based on redemption time constraints
              const currentTimestamp = await retry(() => signer.provider.getBlock('latest').then(block => block.timestamp));
              const validRegularIds = [];
              
              console.log(`PID ${pid}: Current timestamp: ${currentTimestamp}`);
              
              for (const rId of regularIds) {
                try {
                  // Get userRegular info for this rId
                  const userRegular = await retry(() => oldSousChef.userRegluars(userAddress, rId));
                  console.log(`PID ${pid}: userRegular for rId ${rId}:`, userRegular);
                  
                  const redemptionStart = Number(userRegular.redemptionStart);
                  const redemptionEnd = Number(userRegular.redemptionEnd);
                  const amount = BigInt(userRegular.amount);
                  
                  console.log(`PID ${pid}: rId ${rId} - start: ${redemptionStart}, end: ${redemptionEnd}, amount: ${ethers.formatUnits(amount)}`);
                  
                  // Check if redemption time is within range and amount > 0
                  const timeInRange = currentTimestamp >= redemptionStart && currentTimestamp <= redemptionEnd;
                  const hasAmount = amount > 0n;
                  
                  console.log(`PID ${pid}: rId ${rId} - timeInRange: ${timeInRange}, hasAmount: ${hasAmount}`);
                  
                  if (timeInRange && hasAmount) {
                    validRegularIds.push(rId);
                    console.log(`PID ${pid}: rId ${rId} is valid`);
                  } else {
                    console.log(`PID ${pid}: rId ${rId} is invalid`);
                  }
                } catch (error) {
                  console.warn(`PID ${pid}: Failed to check userRegular for rId ${rId}:`, error.message);
                }
              }
              
              regularIds = validRegularIds;
              console.log(`PID ${pid}: Filtered valid regularIds:`, regularIds);
              
            } catch (error) {
              console.warn(`PID ${pid}: Failed to get userPoolRegular, using empty array:`, error.message);
              regularIds = [];
            }
          }
          
          const isLp = false;
          const isWETH = false;

          // Check redemption period constraint for poolType 1
          if (poolInfo.poolType.toString() === '1') {
            // Try to get redemption period from pool info
            let redemptionPeriod = 0;
            if (poolInfo.redemptionPeriod !== undefined) {
              redemptionPeriod = Number(poolInfo.redemptionPeriod);
            } else if (poolInfo.redemptionDelay !== undefined) {
              redemptionPeriod = Number(poolInfo.redemptionDelay);
            } else if (poolInfo.period !== undefined) {
              redemptionPeriod = Number(poolInfo.period);
            }
            
            console.log(`PID ${pid}: Pool type 1 - redemptionPeriod: ${redemptionPeriod}, regularIds.length: ${regularIds.length}`);
            
            // If we can't determine redemption period, assume it's 0 (no redemption period)
            if (isNaN(redemptionPeriod)) {
              redemptionPeriod = 0;
              console.log(`PID ${pid}: Could not determine redemption period, assuming 0`);
            }
            
            // Apply the constraint: (regularIds.length > 0) == (redemptionPeriod > 0)
            if (redemptionPeriod > 0 && regularIds.length === 0) {
              console.log(`PID ${pid}: Pool type 1 has redemptionPeriod > 0 but no valid regularIds found, skipping withdrawal`);
              continue;
            }
            
            if (redemptionPeriod === 0 && regularIds.length > 0) {
              console.log(`PID ${pid}: Pool type 1 has redemptionPeriod = 0 but regularIds found, clearing regularIds`);
              regularIds = [];
            }
          }

          console.log(`PID ${pid}: Withdrawing with regularIds:`, regularIds);
          const receipt = await send(
            () => oldSousChef.withdraw(pid, stakedAmount, regularIds, isLp, isWETH)
          );
          
          // Debug: Log all events to understand the structure
          // console.log(`PID ${pid}: Transaction receipt:`, toObject(receipt));
          console.log(`PID ${pid}: Transaction receipt events:`, receipt.events?.map(e => ({ name: e.event, args: e.args })));
          
          // Try to find Withdraw event with more flexible matching
          let event = receipt.events?.find(e => e.event === 'Withdraw' && e.args.pid == pid);
          
          // If not found, try alternative event names or structures
          if (!event) {
            event = receipt.events?.find(e => e.event === 'Withdraw');
          }
          
          if (!event) {
            event = receipt.events?.find(e => e.event && e.event.toLowerCase().includes('withdraw'));
          }
          
          if (!event) {
            console.warn(`PID ${pid}: Could not find Withdraw event. Available events:`, receipt.events?.map(e => e.event));
            // Fallback: use the staked amount * 99.5% as the amount to deposit (accounting for potential fees)
            amountToDeposit = stakedAmount * 995n / 1000n;
            tokenAddress = poolInfo.token;
            console.log(`PID ${pid}: Using staked amount * 99.5% as fallback: ${ethers.formatUnits(amountToDeposit)}`);
          } else {
            amountToDeposit = event.args.amount;
            tokenAddress = poolInfo.token;
            console.log(`PID ${pid}: Found event: ${event.event}, amount: ${ethers.formatUnits(amountToDeposit)}`);
          }

          setPending(userAddress, pid, { tokenAddress, amount: amountToDeposit.toString() }, "souschef");
          console.log(`PID ${pid}: Withdrawal complete. Saved state to localStorage.`);
        }
      }

      // Deposit to New SousChef if there's an amount to deposit
      if (amountToDeposit && amountToDeposit > 0n) {
        // Special handling for PID 22: deposit to PID 54 instead
        const targetPid = pid === 22 ? 54 : pid;
        
        // Check if pool is active (allocPoint > 0)
        const poolInfo = await retry(() => newSousChef.pools(targetPid));
        if (poolInfo.allocPoint.toString() === '0') {
          console.log(`PID ${pid}: Target pool ${targetPid} allocPoint is 0, skipping deposit to new SousChef`);
        } else {
          const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
          
          // Check wallet balance before deposit
          const walletBalance = await retry(() => tokenContract.balanceOf(userAddress));
          const actualDepositAmount = walletBalance < amountToDeposit ? walletBalance : amountToDeposit;
          
          if (actualDepositAmount <= 1n) {
            console.log(`PID ${pid}: Wallet balance is <= 1, skipping deposit to new SousChef`);
            continue;
          }
          
          console.log(`PID ${pid}: Wallet balance: ${ethers.formatUnits(walletBalance)}, intended deposit: ${ethers.formatUnits(amountToDeposit)}, actual deposit: ${ethers.formatUnits(actualDepositAmount)}`);
          
          // Check current allowance
          const currentAllowance = await retry(() => tokenContract.allowance(userAddress, NEW_SOUSCHEF_ADDRESS));
          if (currentAllowance < actualDepositAmount) {
            console.log(`PID ${pid}: Current allowance ${ethers.formatUnits(currentAllowance)} is insufficient, approving...`);
            await send(
              () => tokenContract.approve(NEW_SOUSCHEF_ADDRESS, ethers.MaxUint256)
            );
          } else {
            console.log(`PID ${pid}: Current allowance ${ethers.formatUnits(currentAllowance)} is sufficient, skipping approve`);
          }

          await send(
            () => newSousChef.deposit(targetPid, actualDepositAmount, ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"], [0, 0])
          );
          console.log(`PID ${pid}: Deposit to new SousChef pool ${targetPid} complete.`);
        }
      }
      
      // Calculate final rewards AFTER funds migration is complete
      const finalUserPool = await retry(() => oldSousChef.userPools(userAddress, pid));
      const finalPendingRewards = await retry(() => oldSousChef.pendingV42(pid, userAddress));
      const totalRewardsToClaim = BigInt(finalPendingRewards || 0) + BigInt(finalUserPool.reward || 0);

      if (totalRewardsToClaim > 0n) {
          pidsToClaim.push(pid);
          amountsToClaim.push(totalRewardsToClaim);
          console.log(`PID ${pid}: Queued rewards for claiming: ${ethers.formatUnits(totalRewardsToClaim)}`);
      }
      
      // Clear pending state if it exists
      if (pending) {
        clearPending(userAddress, pid, "souschef");
        console.log(`PID ${pid}: State cleared from localStorage.`);
      }
      
      console.log(`PID ${pid}: SousChef processing for this pool completed successfully!`);

    } catch (error) {
      console.error(`PID ${pid}: SousChef migration for this pool FAILED. Details:`, error.message || error);
      console.log(`Please try again. The script will attempt to recover from the last successful step.`);
    }
  }

  // After all pools are processed, claim all rewards at once
  if (pidsToClaim.length > 0) {
    console.log(`--- Claiming all queued rewards from Old SousChef ---`);
    try {
      const lpPid = 22;
      const v42UsdtLpAddress = await retry(() => oldSousChef.V42_USDT());
      const v42UsdtLpContract = new ethers.Contract(v42UsdtLpAddress, IParaPair_ABI, signer);
      const [reserve0, reserve1] = await retry(() => v42UsdtLpContract.getReserves());

      let preTokensAmount_ = [BigInt(reserve0) * 99n / 100n, BigInt(reserve0), BigInt(reserve1) * 99n / 100n, BigInt(reserve1)];

      await send(
        () => oldSousChef.safeClaim(preTokensAmount_, pidsToClaim, amountsToClaim, lpPid, userAddress)
      );
      console.log("All rewards claimed successfully.");
    } catch (error) {
      console.error(`Failed to claim all rewards. Details:`, error.message || error);
    }
  } else {
    console.log("No rewards to claim from SousChef.");
  }

  console.log("--- SousChef migration process finished. ---");
}


async function migrate(signer) {
  console.log("Running all migrations...");
  await migrateMC(signer);
  await migrateSC(signer);
  console.log("All migrations complete.");
}


if (typeof window !== 'undefined') {
  window.migration = {
    migrate,
    migrateMC,
    migrateSC,
  };
}

module.exports = {
  migrate,
  migrateMC,
  migrateSC,
};


