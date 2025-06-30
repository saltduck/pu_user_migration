

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
];

// --- LocalStorage Persistence Helpers ---
const getStorageKey = (user, pid, type = "masterchef") => `migration_${type}_${user}_pid_${pid}`;

const getPendingMigration = (user, pid, type = "masterchef") => {
  try {
    if (typeof localStorage === 'undefined') return null;
    const pending = localStorage.getItem(getStorageKey(user, pid, type));
    return pending ? JSON.parse(pending) : null;
  } catch (e) {
    console.error("Could not read from localStorage", e);
    return null;
  }
};

const setPendingMigration = (user, pid, data, type = "masterchef") => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(getStorageKey(user, pid, type), JSON.stringify(data));
  } catch (e) {
    console.error("Could not write to localStorage", e);
  }
};

const clearPendingMigration = (user, pid, type = "masterchef") => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(getStorageKey(user, pid, type));
  } catch (e) {
    console.error("Could not remove from localStorage", e);
  }
};

// --- Helper for retrying failed read-only calls ---
async function withRetries(fn, retries = 3, delay = 1000) {
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
async function sendTransaction(txFunction, description) {
  console.log(`${description}...`);
  const tx = await txFunction();
  console.log(`TX sent: ${tx.hash}. Waiting for confirmation...`);
  const receipt = await tx.wait();
  if (receipt.status === 0) {
    throw new Error(`Transaction failed (reverted). TX: ${tx.hash}`);
  }
  console.log(`TX successful: ${tx.hash}`);
  return receipt;
}

async function migrateMasterChef(signer) {
  const oldMasterChef = new ethers.Contract(OLD_MASTERCHEF_ADDRESS, MASTERCHEF_ABI, signer);
  const newMasterChef = new ethers.Contract(NEW_MASTERCHEF_ADDRESS, MASTERCHEF_ABI, signer);
  const userAddress = await signer.getAddress();

  console.log(`Starting MasterChef migration for user: ${userAddress}...`);

  let poolLength;
  try {
    poolLength = await withRetries(() => oldMasterChef.poolLength());
    console.log(`Found ${poolLength} pools in the old MasterChef.`);
  } catch (error) {
    console.error("Fatal: Could not fetch pool length. Aborting.", error);
    return;
  }

  for (let pid = 0; pid < poolLength; pid++) {
    try {
      console.log(`--- Processing MasterChef PID ${pid} ---`);
      const pending = getPendingMigration(userAddress, pid, "masterchef");

      let lpTokenAddress, amountToDeposit;
      const poolInfo = await withRetries(() => oldMasterChef.poolInfo(pid));
      const isVipPool = poolInfo.pooltype.toString() === '1';

      if (pending) {
        console.log(`PID ${pid}: Found pending migration in localStorage. Recovering...`);
        lpTokenAddress = pending.lpTokenAddress;
        amountToDeposit = ethers.BigNumber.from(pending.amount);
      } else {
        const userInfo = await withRetries(() => oldMasterChef.userInfo(pid, userAddress));
        const stakedAmount = userInfo.amount;
        const hasStakedLp = !stakedAmount.isZero();

        if (!hasStakedLp && !isVipPool) {
          console.log(`PID ${pid}: No funds or VIP tickets to migrate. Skipping.`);
          continue;
        }

        if (hasStakedLp) {
          const receipt = await sendTransaction(
            () => oldMasterChef.withdraw(pid, stakedAmount),
            `PID ${pid}: Withdrawing ${ethers.utils.formatUnits(stakedAmount)} LP tokens`
          );
          const event = receipt.events?.find(e => e.event === 'Withdraw' && e.args.pid.eq(pid));
          if (!event) throw new Error("Could not find Withdraw event.");
          
          amountToDeposit = event.args.amount;
          lpTokenAddress = poolInfo.lpToken;

          setPendingMigration(userAddress, pid, { lpTokenAddress, amount: amountToDeposit.toString() }, "masterchef");
          console.log(`PID ${pid}: Withdrawal complete. Saved state to localStorage.`);
        }
      }

      // Migrate Tickets for VIP pools
      if (isVipPool) {
        const ticketAddress = poolInfo.ticket;
        const stakedTickets = await withRetries(() => oldMasterChef.ticket_staked_array(userAddress, ticketAddress));
        if (stakedTickets.length > 0) {
          console.log(`PID ${pid}: Migrating ${stakedTickets.length} tickets...`);
          for (const tokenId of stakedTickets) {
            await sendTransaction(() => oldMasterChef.withdraw_tickets(pid, tokenId), `Withdrawing ticket #${tokenId}`);
          }
          await sendTransaction(() => newMasterChef.deposit_all_tickets(ticketAddress), `Depositing all tickets`);
        }
      }

      // Deposit LP to new MasterChef
      if (amountToDeposit && amountToDeposit.gt(0)) {
        const lpTokenContract = new ethers.Contract(lpTokenAddress, ERC20_ABI, signer);
        await sendTransaction(
          () => lpTokenContract.approve(NEW_MASTERCHEF_ADDRESS, amountToDeposit),
          `Approving new MC for ${ethers.utils.formatUnits(amountToDeposit)} LP tokens`
        );
        await sendTransaction(
          () => newMasterChef.deposit(pid, amountToDeposit),
          `Depositing ${ethers.utils.formatUnits(amountToDeposit)} LP tokens`
        );
      }

      clearPendingMigration(userAddress, pid, "masterchef");
      console.log(`PID ${pid}: Migration for this pool completed successfully! State cleared.`);

    } catch (error) {
      console.error(`PID ${pid}: MasterChef migration for this pool FAILED. Details:`, error.message || error);
      console.log(`Please try again. The script will attempt to recover from the last successful step.`);
    }
  }

  console.log("--- MasterChef migration process finished. ---");
}

async function migrateSousChef(signer) {
  const oldSousChef = new ethers.Contract(OLD_SOUSCHEF_ADDRESS, SOUSCHEF_ABI, signer);
  const newSousChef = new ethers.Contract(NEW_SOUSCHEF_ADDRESS, SOUSCHEF_ABI, signer);
  const userAddress = await signer.getAddress();

  console.log(`Starting SousChef migration for user: ${userAddress}...`);

  let poolLength;
  try {
    poolLength = await withRetries(() => oldSousChef.poolLength());
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
      const pending = getPendingMigration(userAddress, pid, "souschef");
      
      let tokenAddress, amountToDeposit;

      if (pending) {
        console.log(`PID ${pid}: Found pending migration in localStorage. Recovering...`);
        tokenAddress = pending.tokenAddress;
        amountToDeposit = ethers.BigNumber.from(pending.amount);
      } else {
        const userPoolInfo = await withRetries(() => oldSousChef.userPools(userAddress, pid));
        const stakedAmount = userPoolInfo.deposit;

        if (stakedAmount.gt(0)) {
          console.log(`PID ${pid}: Staked amount is ${ethers.utils.formatUnits(stakedAmount)}. Starting withdrawal...`);
          const poolInfo = await withRetries(() => oldSousChef.pools(pid));
          const regularIds = poolInfo.poolType.toString() === '1' ? await withRetries(() => oldSousChef.getUserPoolRegular(userAddress, pid)) : [];
          const isLp = false;
          const isWETH = false;

          const receipt = await sendTransaction(
            () => oldSousChef.withdraw(pid, stakedAmount, regularIds, isLp, isWETH),
            `PID ${pid}: Withdrawing ${ethers.utils.formatUnits(stakedAmount)} tokens`
          );
          
          const event = receipt.events?.find(e => e.event === 'Withdraw' && e.args.pid.eq(pid));
          if (!event) throw new Error("Could not find Withdraw event.");

          amountToDeposit = event.args.amount;
          tokenAddress = poolInfo.token;

          setPendingMigration(userAddress, pid, { tokenAddress, amount: amountToDeposit.toString() }, "souschef");
          console.log(`PID ${pid}: Withdrawal complete. Saved state to localStorage.`);
        }
      }

      // Deposit to New SousChef if there's an amount to deposit
      if (amountToDeposit && amountToDeposit.gt(0)) {
        console.log(`PID ${pid}: Depositing ${ethers.utils.formatUnits(amountToDeposit)} tokens to new SousChef...`);
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
        await sendTransaction(
          () => tokenContract.approve(NEW_SOUSCHEF_ADDRESS, amountToDeposit),
          `PID ${pid}: Approving new SC for ${ethers.utils.formatUnits(amountToDeposit)} tokens`
        );

        await sendTransaction(
          () => newSousChef.deposit(pid, amountToDeposit, [ethers.constants.AddressZero, ethers.constants.AddressZero], [0, 0]),
          `PID ${pid}: Depositing ${ethers.utils.formatUnits(amountToDeposit)} tokens to new SC`
        );
        console.log(`PID ${pid}: Deposit to new SousChef complete.`);
      }
      
      // Calculate final rewards AFTER funds migration is complete
      const finalUserPool = await withRetries(() => oldSousChef.userPools(userAddress, pid));
      const finalPendingRewards = await withRetries(() => oldSousChef.pendingV42(pid, userAddress));
      const totalRewardsToClaim = finalPendingRewards.add(finalUserPool.reward);

      if (totalRewardsToClaim.gt(0)) {
          pidsToClaim.push(pid);
          amountsToClaim.push(totalRewardsToClaim);
          console.log(`PID ${pid}: Queued rewards for claiming: ${ethers.utils.formatUnits(totalRewardsToClaim)}`);
      }
      
      // Clear pending state if it exists
      if (pending) {
        clearPendingMigration(userAddress, pid, "souschef");
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
      await sendTransaction(
        () => oldSousChef.claim(pidsToClaim, amountsToClaim, lpPid, userAddress),
        `Claiming rewards for PIDs: [${pidsToClaim.join(", ")}]`
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


async function migrateAll(signer) {
  console.log("Running all migrations...");
  await migrateMasterChef(signer);
  await migrateSousChef(signer);
  console.log("All migrations complete.");
}

module.exports = {
  migrateAll,
  migrateMasterChef,
  migrateSousChef,
};

