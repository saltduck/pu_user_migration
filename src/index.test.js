
// Mock the entire ethers library
jest.mock('ethers');

// Now import the mocked library and the real one for utilities
const { ethers } = require('ethers');
const originalEthers = jest.requireActual('ethers');

// Re-assign the utilities we need from the real library to the mocked one
ethers.parseEther = originalEthers.parseEther;
ethers.ZeroAddress = originalEthers.ZeroAddress;
ethers.constants = originalEthers.constants;

// Import the functions to be tested
const { migrateMasterChef, migrateSousChef, migrateAll } = require("./index.js");
const { MASTERCHEF_ABI, SOUSCHEF_ABI } = require("./abi.js");
const index = require('./index.js');

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

  beforeEach(() => {
    jest.clearAllMocks();
    localStorageMock.clear();

    signer = {
      getAddress: jest.fn().mockResolvedValue("0xUserAddress"),
      provider: {
        getNetwork: jest.fn().mockResolvedValue({ chainId: 1 }),
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
      if (abi === MASTERCHEF_ABI) {
        return address.includes("OLD") ? mockOldMasterChef : mockNewMasterChef;
      }
      if (abi === SOUSCHEF_ABI) {
        return address.includes("OLD") ? mockOldSousChef : mockNewSousChef;
      }
      return mockToken;
    });
  });

  describe("migrateMasterChef", () => {
    it("should migrate a standard LP pool correctly", async () => {
      mockOldMasterChef.poolLength.mockResolvedValue(1);
      mockOldMasterChef.poolInfo.mockResolvedValue({ lpToken: "0xLpTokenAddress", pooltype: '0' });
      mockOldMasterChef.userInfo.mockResolvedValue({ amount: ethers.parseEther("10") });
      mockOldMasterChef.withdraw.mockResolvedValue({
        hash: "0xWithdrawTx",
        wait: jest.fn().mockResolvedValue({
          status: 1,
          events: [{ event: "Withdraw", args: { pid: 0, amount: ethers.parseEther("10") } }],
        }),
      });
      mockNewMasterChef.deposit.mockResolvedValue({ hash: "0xDepositTx", wait: jest.fn().mockResolvedValue({ status: 1 }) });
      mockToken.approve.mockResolvedValue({ hash: "0xApproveTx", wait: jest.fn().mockResolvedValue({ status: 1 }) });

      await migrateMasterChef(signer);

      expect(mockOldMasterChef.withdraw).toHaveBeenCalledWith(0, ethers.parseEther("10"));
      expect(mockToken.approve).toHaveBeenCalledWith(expect.any(String), ethers.parseEther("10"));
      expect(mockNewMasterChef.deposit).toHaveBeenCalledWith(0, ethers.parseEther("10"));
    });
  });
  
  describe("migrateSousChef", () => {
    it("should withdraw, deposit, and then claim rewards", async () => {
        mockOldSousChef.poolLength.mockResolvedValue(1);
        mockOldSousChef.userPools
            .mockResolvedValueOnce({ deposit: ethers.parseEther("100"), reward: ethers.parseEther("0") })
            .mockResolvedValueOnce({ deposit: ethers.parseEther("0"), reward: ethers.parseEther("15") });
        mockOldSousChef.pendingV42
            .mockResolvedValueOnce(ethers.parseEther("0"))
            .mockResolvedValueOnce(ethers.parseEther("0"));
        mockOldSousChef.pools.mockResolvedValue({ token: "0xStakeTokenAddress", poolType: '0' });
        mockOldSousChef.getUserPoolRegular.mockResolvedValue([]);
        mockOldSousChef.withdraw.mockResolvedValue({
            hash: "0xSousWithdrawTx",
            wait: jest.fn().mockResolvedValue({
                status: 1,
                events: [{ event: "Withdraw", args: { pid: 0, amount: ethers.parseEther("100") } }],
            }),
        });
        mockNewSousChef.deposit.mockResolvedValue({ hash: "0xNewSousDepositTx", wait: jest.fn().mockResolvedValue({ status: 1 }) });
        mockToken.approve.mockResolvedValue({ hash: "0xApproveTx", wait: jest.fn().mockResolvedValue({ status: 1 }) });
        mockOldSousChef.claim.mockResolvedValue({ hash: "0xClaimTx", wait: jest.fn().mockResolvedValue({ status: 1 }) });

        await migrateSousChef(signer);

        expect(mockOldSousChef.withdraw).toHaveBeenCalledWith(0, ethers.parseEther("100"), [], false, false);
        expect(mockToken.approve).toHaveBeenCalledWith(expect.any(String), ethers.parseEther("100"));
        expect(mockNewSousChef.deposit).toHaveBeenCalledWith(0, ethers.parseEther("100"), [ethers.constants.AddressZero, ethers.constants.AddressZero], [0, 0]);
        expect(mockOldSousChef.claim).toHaveBeenCalledWith([0], [ethers.parseEther("15")], 22, "0xUserAddress");
    });
  });

  describe("migrateAll", () => {
    it("should call migrateMasterChef and then migrateSousChef in order", async () => {
        const masterChefSpy = jest.spyOn(index, 'migrateMasterChef').mockResolvedValue();
        const sousChefSpy = jest.spyOn(index, 'migrateSousChef').mockResolvedValue();

        await migrateAll(signer);

        expect(masterChefSpy).toHaveBeenCalledWith(signer);
        expect(sousChefSpy).toHaveBeenCalledWith(signer);
        
        const masterChefOrder = masterChefSpy.mock.invocationCallOrder[0];
        const sousChefOrder = sousChefSpy.mock.invocationCallOrder[0];
        expect(masterChefOrder).toBeLessThan(sousChefOrder);

        masterChefSpy.mockRestore();
        sousChefSpy.mockRestore();
    });
  });
});
