
// Description: Unit tests for user migration script
// Author: hsn
// Date: 2024-07-29

const { ethers } = require('ethers');
const originalEthers = jest.requireActual('ethers');

// Mock the entire ethers library
jest.mock('ethers');

// Re-assign the utilities we need from the real library to the mocked one
ethers.parseEther = originalEthers.parseEther;
ethers.ZeroAddress = originalEthers.ZeroAddress;
ethers.constants = { AddressZero: originalEthers.ZeroAddress };

// Mock localStorage
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: (key) => store[key] || null,
    setItem: (key, value) => { store[key] = value.toString(); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(global, 'localStorage', { value: localStorageMock });

describe("User Migration Scripts", () => {
  let signer;
  let mockOldMasterChef, mockNewMasterChef, mockOldSousChef, mockNewSousChef, mockToken;
  let migrateMC, migrateSC, migrate;
  let MASTERCHEF_ABI, SOUSCHEF_ABI, IParaPair_ABI;
  let index; // To hold the imported module for spying

  beforeEach(() => {
    jest.clearAllMocks();
    localStorageMock.clear();

    // Import the functions to be tested inside beforeEach
    // This ensures they use the mocked ethers
    index = require('./index.js');
    ({ migrateMC, migrateSC, migrate } = index);
    ({ MASTERCHEF_ABI, SOUSCHEF_ABI, IParaPair_ABI } = require('./abi.js'));

    signer = {
      getAddress: jest.fn().mockResolvedValue("0xUserAddress"),
      provider: {
        getNetwork: jest.fn().mockResolvedValue({ chainId: 1 }),
        getBlockNumber: jest.fn().mockResolvedValue(100), // Mock current block number
      }
    };

    // Define mock objects with jest.fn() for each method
    mockOldMasterChef = {
      poolLength: jest.fn(),
      poolInfo: jest.fn(),
      userInfo: jest.fn(),
      withdraw: jest.fn(),
      ticket_staked_array: jest.fn(),
      connect: jest.fn().mockReturnThis(),
    };
    mockNewMasterChef = {
      deposit: jest.fn(),
      deposit_all_tickets: jest.fn(),
      connect: jest.fn().mockReturnThis(),
    };
    mockOldSousChef = {
      poolLength: jest.fn(),
      userPools: jest.fn(),
      pendingV42: jest.fn(),
      pools: jest.fn(),
      getUserPoolRegular: jest.fn(),
      withdraw: jest.fn(),
      claim: jest.fn(),
      safeClaim: jest.fn().mockResolvedValue({ hash: "0xClaimTx", wait: jest.fn().mockResolvedValue({ status: 1 }) }), // Added safeClaim
      V42_USDT: jest.fn(), // Added V42_USDT
      userNoFeeTime: jest.fn(), // Added userNoFeeTime
      connect: jest.fn().mockReturnThis(),
    };
    mockNewSousChef = {
      deposit: jest.fn(),
      connect: jest.fn().mockReturnThis(),
    };
    mockToken = {
      approve: jest.fn(),
      connect: jest.fn().mockReturnThis(),
    };

    // Since ethers.Contract is now a mock function, we can provide its implementation
    ethers.Contract.mockImplementation((address, abi) => {
      if (address === "0x77341bF31472E9c896f36F4a448fdf573A0D9B60") {
        return mockOldMasterChef;
      }
      if (address === "0x192923A619FC6Abf1c17fEbC0d9d1C9bEE3a02a5") {
        return mockNewMasterChef;
      }
      if (address === "0x9F68bcE058901D3583A122889BE27a4D2f55b656") {
        return mockOldSousChef;
      }
      if (address === "0x26A6320Ca85EE981dCf39Ad77A87EDFF464f00DF") {
        return mockNewSousChef;
      }
      // Mock IParaPair_ABI for V42_USDT
      if (address === "0x7482dC9D6c9238d424935A3e2617572Cc3083Ba4") {
        return {
          getReserves: jest.fn().mockResolvedValue([100000000000000000000n, 200000000000000000000n]), // Example reserves
          token0: jest.fn().mockResolvedValue("0xToken0Address"),
          token1: jest.fn().mockResolvedValue("0xToken1Address"),
          connect: jest.fn().mockReturnThis(),
        };
      }
      if (abi.some(item => item.name === "getReserves")) {
        return {
          getReserves: jest.fn().mockResolvedValue([100000000000000000000n, 200000000000000000000n]), // Example reserves
          token0: jest.fn().mockResolvedValue("0xToken0Address"),
          token1: jest.fn().mockResolvedValue("0xToken1Address"),
          connect: jest.fn().mockReturnThis(),
        };
      }
      return mockToken;
    });
  });

  describe("migrateMC", () => {
    it("should migrate a standard LP pool correctly", async () => {
      mockOldMasterChef.poolLength.mockResolvedValue(1);
      mockOldMasterChef.poolInfo.mockResolvedValue({ lpToken: "0xLpTokenAddress", pooltype: '0' });
      mockOldMasterChef.userInfo.mockResolvedValue({ amount: 10000000000000000000n });
      mockOldMasterChef.withdraw.mockResolvedValue({
        hash: "0xWithdrawTx",
        wait: jest.fn().mockResolvedValue({
          status: 1,
          events: [{ event: "Withdraw", args: { pid: 0, amount: 10000000000000000000n } }],
        }),
      });
      mockNewMasterChef.deposit.mockResolvedValue({ hash: "0xDepositTx", wait: jest.fn().mockResolvedValue({ status: 1 }) });
      mockToken.approve.mockResolvedValue({ hash: "0xApproveTx", wait: jest.fn().mockResolvedValue({ status: 1 }) });

      await migrateMC(signer);

      expect(mockOldMasterChef.withdraw).toHaveBeenCalledWith(0, 10000000000000000000n);
      expect(mockToken.approve).toHaveBeenCalledWith(expect.any(String), 10000000000000000000n);
      expect(mockNewMasterChef.deposit).toHaveBeenCalledWith(0, 10000000000000000000n);
    });
  });
  
  describe("migrateSC", () => {
    it("should withdraw, deposit, and then claim rewards", async () => {
        mockOldSousChef.poolLength.mockResolvedValue(1);
        mockOldSousChef.userPools
            .mockResolvedValueOnce({ deposit: 100000000000000000000n, reward: 0n })
            .mockResolvedValueOnce({ deposit: 0n, reward: 15000000000000000000n });
        mockOldSousChef.pendingV42
            .mockResolvedValueOnce(0n)
            .mockResolvedValueOnce(0n);
        mockOldSousChef.pools.mockResolvedValue({ token: "0xStakeTokenAddress", poolType: '0', redemptionDelay: 10 });
        mockOldSousChef.V42_USDT.mockResolvedValue("0x7482dC9D6c9238d424935A3e2617572Cc3083Ba4");
        mockOldSousChef.userNoFeeTime.mockResolvedValue(110); // currentBlockNumber (100) + redemptionDelay (10)
        mockOldSousChef.getUserPoolRegular.mockResolvedValue([]);
        mockOldSousChef.withdraw.mockResolvedValue({
            hash: "0xSousWithdrawTx",
            wait: jest.fn().mockResolvedValue({
                status: 1,
                events: [{ event: "Withdraw", args: { pid: 0, amount: 100000000000000000000n } }],
            }),
        });
        mockNewSousChef.deposit.mockResolvedValue({ hash: "0xNewSousDepositTx", wait: jest.fn().mockResolvedValue({ status: 1 }) });
        mockToken.approve.mockResolvedValue({ hash: "0xApproveTx", wait: jest.fn().mockResolvedValue({ status: 1 }) });
        mockOldSousChef.claim.mockResolvedValue({ hash: "0xClaimTx", wait: jest.fn().mockResolvedValue({ status: 1 }) });

        await migrateSC(signer);

        expect(mockOldSousChef.withdraw).toHaveBeenCalledWith(0, 100000000000000000000n, [], false, false);
        expect(mockToken.approve).toHaveBeenCalledWith(expect.any(String), 100000000000000000000n);
        expect(mockNewSousChef.deposit).toHaveBeenCalledWith(0, 100000000000000000000n, [ethers.constants.AddressZero, ethers.constants.AddressZero], [0, 0]);
        expect(mockOldSousChef.safeClaim).toHaveBeenCalledWith([0], [15000000000000000000n], 22, "0xUserAddress", [99000000000000000000n, 100000000000000000000n, 198000000000000000000n, 200000000000000000000n]);
    });

    it("should skip withdrawal for poolType 4 or 7 if maturity is not 100%", async () => {
      mockOldSousChef.poolLength.mockResolvedValue(1);
      mockOldSousChef.userPools.mockResolvedValueOnce({ deposit: 100000000000000000000n, reward: 0n });
      mockOldSousChef.pools.mockResolvedValue({ token: "0xStakeTokenAddress", poolType: '4', redemptionDelay: 10 });
      mockOldSousChef.userNoFeeTime.mockResolvedValue(105); // currentBlockNumber (100) + 5, so maturity is 5/10 = 50%

      await migrateSC(signer);

      expect(mockOldSousChef.withdraw).not.toHaveBeenCalled();
      expect(mockNewSousChef.deposit).not.toHaveBeenCalled();
      expect(mockOldSousChef.safeClaim).not.toHaveBeenCalled();
    });
  });

  
});
