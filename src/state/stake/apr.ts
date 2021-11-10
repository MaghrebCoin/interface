import { ChainId, Token, JSBI, Pair, WETH, TokenAmount } from '@trisolaris/sdk'
import { USDC, DAI } from '../../constants'
import { useTokenContract } from '../../hooks/useContract'
import { useMasterChefContract, MASTERCHEF_ADDRESS } from './hooks-sushi'
import { STAKING, StakingTri, TRI, ADDRESS_PRICE_MAP } from './stake-constants'
import { useSingleContractMultipleData, useMultipleContractSingleData, useSingleCallResult, NEVER_RELOAD } from '../../state/multicall/hooks'
import ERC20_INTERFACE from '../../constants/abis/erc20'
import { useMemo } from 'react'
import { PairState, usePairs, usePair } from '../../data/Reserves'
import { useActiveWeb3React } from '../../hooks'




// gets the staking info from the network for the active chain id
export function useFarms(): StakingTri[] {
  const { chainId, account } = useActiveWeb3React()

  const activeFarms = STAKING[chainId ? chainId! : ChainId.AURORA]
  let lpAddresses = activeFarms.map(key => key.stakingRewardAddress);
  const chefContract = useMasterChefContract()

  // user info
  const args = useMemo(() => {
    if (!account || !lpAddresses) {
      return
    }
    return [...Array(lpAddresses.length).keys()].map(pid => [String(pid), String(account)])
  }, [lpAddresses.length, account])

  const pendingTri = useSingleContractMultipleData(args ? chefContract : null, 'pendingTri', args!)
  const userInfo = useSingleContractMultipleData(args ? chefContract : null, 'userInfo', args!)
    
  // get all the info from the staking rewards contracts
  const accountArg = useMemo(() => [chefContract?.address ?? undefined], [chefContract])
  const tokens = useMemo(() => activeFarms.map(({ tokens }) => tokens), [activeFarms])
  const stakingTotalSupplies = useMultipleContractSingleData(lpAddresses, ERC20_INTERFACE, 'balanceOf', accountArg)
  const pairs = usePairs(tokens)
  
  const pairAddresses = useMemo(() => {
    const pairsHaveLoaded = pairs?.every(([state, pair]) => state === PairState.EXISTS)
    if (!pairsHaveLoaded) return []
    else return pairs.map(([state, pair]) => pair?.liquidityToken.address)
  }, [pairs])

  // useTokenPrices(tokenAddresses)
  const pairTotalSupplies = useMultipleContractSingleData(pairAddresses, ERC20_INTERFACE, 'totalSupply')
  
  // get pairs for tvl calculation
  const dai = DAI[chainId ? chainId! : ChainId.AURORA]
  const usdc = USDC[chainId ? chainId! : ChainId.AURORA]
  const [daiUSDCPairState, daiUSDCPair] = usePair(dai, usdc);
  const [triUSDCPairState, triUSDCPair] = usePair(TRI, usdc);
  // TODO add a wNEAR pair to calculate for wnear pools

  // apr calculation
  const chefRewardsPerSecond = useSingleCallResult(chefContract, 'triPerBlock')
  const chefTotalAllocPoints = useSingleCallResult(chefContract, 'totalAllocPoint')

  return useMemo(() => {
    if (!chainId) return activeFarms

    return lpAddresses.reduce<StakingTri[]>((memo, lpAddress, index) => {
      // User based info
      const userStaked = userInfo[index]
      const rewardsPending = pendingTri[index]

      // these get fetched regardless of account
      const stakingTotalSupplyState = stakingTotalSupplies[index]
      const [pairState, pair] = pairs[index]
      const pairTotalSupplyState = pairTotalSupplies[index]

      if (
        // always need these
        userStaked?.loading === false &&
        rewardsPending?.loading === false &&
        stakingTotalSupplyState?.loading === false &&
        pairTotalSupplyState?.loading === false &&
        chefRewardsPerSecond?.loading === false &&
        chefTotalAllocPoints?.loading === false &&
        pair &&
        pairState !== PairState.LOADING &&
        daiUSDCPair &&
        daiUSDCPairState !== PairState.LOADING &&
        triUSDCPair &&
        triUSDCPairState !== PairState.LOADING
      ) {
        if (
          userStaked.error ||
          rewardsPending.error ||
          stakingTotalSupplyState.error ||
          pairTotalSupplyState.error ||
          chefRewardsPerSecond.error ||
          chefTotalAllocPoints.error ||
          pairState === PairState.INVALID ||
          pairState === PairState.NOT_EXISTS ||
          daiUSDCPairState === PairState.INVALID ||
          daiUSDCPairState === PairState.NOT_EXISTS ||
          triUSDCPairState === PairState.INVALID ||
          triUSDCPairState === PairState.NOT_EXISTS
        ) {
          console.error('Failed to load staking rewards info')
          return memo
        }

        // get the LP token
        const tokens = activeFarms[index].tokens
        // do whatever

        // check for account, if no account set to 0
        const userInfoPool = JSBI.BigInt(userStaked.result?.["amount"])
        const earnedRewardPool = JSBI.BigInt(rewardsPending.result?.[0])
        const totalSupplyStaked = JSBI.BigInt(stakingTotalSupplyState.result?.[0])
        const totalSupplyAvailable = JSBI.BigInt(pairTotalSupplyState.result?.[0])

        const stakedAmount = new TokenAmount(pair.liquidityToken, JSBI.BigInt(userInfoPool))
        const earnedAmount = new TokenAmount(TRI, JSBI.BigInt(earnedRewardPool))
        const totalStakedAmount = new TokenAmount(pair.liquidityToken, JSBI.BigInt(totalSupplyStaked))

        // tvl calculation
        const reserveInUSDC = calculateReserveInUSDC(pair, daiUSDCPair, usdc, dai);
        const totalStakedAmountInUSD = calculateTotalStakedAmountInUSDC(totalSupplyStaked, totalSupplyAvailable, reserveInUSDC, usdc);

        // apr calculation
        const rewardsPerSecond = JSBI.BigInt(chefRewardsPerSecond.result?.[0])
        const totalAllocPoints = JSBI.BigInt(chefTotalAllocPoints.result?.[0])
        const totalRewardRate = new TokenAmount(TRI, 
          JSBI.divide(
            JSBI.multiply(rewardsPerSecond, JSBI.BigInt(activeFarms[index].allocPoint)),
            totalAllocPoints
          )
        )
        const rewardRate = new TokenAmount(
          TRI,
          JSBI.greaterThan(totalStakedAmount.raw, JSBI.BigInt(0))
            ? JSBI.divide(JSBI.multiply(totalRewardRate.raw, stakedAmount.raw), totalStakedAmount.raw)
            : JSBI.BigInt(0)
        )
        /*
        const triToUsdcRatio = triUSDCPair.priceOf(TRI)
        const totalYearlyRewards = JSBI.multiply(totalRewardRate.raw, JSBI.BigInt(3600 * 24 * 365)) 
        const apr = triToUsdcRatio.raw.multiply(totalYearlyRewards).divide(totalStakedAmountInUSD)
        */
        memo.push({
          ID: activeFarms[index].ID,
          stakingRewardAddress: MASTERCHEF_ADDRESS[chainId],
          tokens: tokens,
          isPeriodFinished: false,
          earnedAmount: earnedAmount,
          stakedAmount: stakedAmount,
          totalStakedAmount: totalStakedAmount,
          totalStakedAmountInUSD: totalStakedAmountInUSD,
          totalStakedAmountInETH: activeFarms[index].totalStakedAmountInETH,
          allocPoint: activeFarms[index].allocPoint,
          totalRewardRate: totalRewardRate,
          rewardRate: rewardRate,
          apr: 10,
        })
        return memo
      }
      return activeFarms
    }, [])
  }, [
    activeFarms,
    stakingTotalSupplies,
    daiUSDCPair,
    triUSDCPair,
    pairs,
    pairTotalSupplies,
    pendingTri,
    userInfo,
    chefRewardsPerSecond,
    chefTotalAllocPoints,
  ])
}

const calculateReserveInUSDC = function(
  pair: Pair,
  daiUsdcPair: Pair,
  usdc: Token,
  dai: Token,
): JSBI {
  // calculating TVL
  if (pair.token0 === usdc || pair.token1 === usdc) {
    return JSBI.multiply(pair.reserveOf(usdc).raw, JSBI.BigInt(2))
  } 
  else if (pair.token0 === dai || pair.token1 === dai) {
    const oneToken = JSBI.BigInt(1000000000000000000)
    const reserveInDai = pair.reserveOf(dai).raw
    const daiReserveInDaiUsdcPair = daiUsdcPair.reserveOf(dai).raw
    const usdcReserveInDaiUsdcPair = daiUsdcPair.reserveOf(usdc).raw
    const usdcDaiRatio = JSBI.divide(JSBI.multiply(oneToken, usdcReserveInDaiUsdcPair), daiReserveInDaiUsdcPair)
    return JSBI.multiply(
      JSBI.divide(JSBI.multiply(reserveInDai, usdcDaiRatio), oneToken), 
      JSBI.BigInt(2)
    ) 
  }
  else {
      console.error('Failed to load staking rewards info')
      return JSBI.BigInt(0)
  }
}

const calculateTotalStakedAmountInUSDC = function(
  amountStaked: JSBI,
  amountAvailable: JSBI,
  reserveInUSDC: JSBI,
  usdc: Token,
): TokenAmount {
  if (JSBI.EQ(amountAvailable, JSBI.BigInt(0))) {
    return new TokenAmount(usdc, JSBI.BigInt(0))
  }
  return new TokenAmount(
    usdc,
    JSBI.divide(
      JSBI.multiply(amountStaked, reserveInUSDC),
      amountAvailable
    )
  )
}

    
    // APR calculation
    /*
    const totalAllocPoints = useSingleCallResult(chefContract, 'totalAllocPoint', undefined, NEVER_RELOAD)?.result?.[0]

    const rewardTokenAddress = useSingleCallResult(chefContract, 'tri', undefined, NEVER_RELOAD)?.result?.[0]
    
    const rewardTokenContract = useTokenContract(rewardTokenAddress);
    
    const rewardsPerSecond = useSingleCallResult(chefContract, 'triPerBlock', undefined, NEVER_RELOAD)?.result?.[0]
    const tokenDecimals = useSingleCallResult(rewardTokenContract, 'decimals', undefined, NEVER_RELOAD)?.result?.[0]
    const rewardsPerWeek =  rewardsPerSecond / 10 ** tokenDecimals * 3600 * 24 * 7;
    */

    /*
    const pools = useMemo(() => {
      if (!poolCount) {
        return
      }
      return [...Array(poolCount.toNumber()).keys()].map(pid => [String(pid)])
    }, [poolCount])
  
    const poolInfos = useSingleContractMultipleData(pools ? chefContract : null, 'poolInfo', pools!);
    const pairAddresses = useMemo(() => {
      if (!poolInfos) {
        return
      }
      return [...Array(poolCount.toNumber()).keys()].map(pid => [String(pid)])
    }, [poolCount])
    */
    
  
  
  
    // var tokenAddresses = [].concat.apply([], poolInfos.map(x => x?.result?.poolToken.tokens))
    // console.log(tokenAddresses)
    // tokenAddresses.map(async (address) => {tokens[address] = useTokenContract(address)});
  
    /*
    var prices = await lookUpTokenPrices(tokenAddresses);
    if (extraPrices) {
      for (const [k,v] of Object.entries(extraPrices)) {
        if (v.usd) {
          prices[k] = v
        }
      }
    }
    //prices["0x194ebd173f6cdace046c53eacce9b953f28411d1"] = { usd : 1.22 } //"temporary" solution
    */
  
  /*
    const poolPrices = poolInfos.map(poolInfo => poolInfo?.poolToken ? getPoolPrices(tokens, prices, poolInfo.poolToken) : undefined);
  
    _print("Finished reading smart contracts.\n");
  
    let aprs = []
    for (let i = 0; i < poolCount; i++) {
      if (poolPrices[i]) {
        const apr = printChefPool(App, chefAbi, chefAddress, prices, tokens, poolInfos[i], i, poolPrices[i],
          totalAllocPoints, rewardsPerWeek, rewardTokenTicker, rewardTokenAddress,
          pendingRewardsFunction)
        aprs.push(apr);
      }
    }
    let totalUserStaked=0, totalStaked=0, averageApr=0;
    for (const a of aprs) {
      if (a && !isNaN(a.totalStakedUsd)) {
        totalStaked += a.totalStakedUsd;
      }
      if (a && a.userStakedUsd > 0) {
        totalUserStaked += a.userStakedUsd;
        averageApr += a.userStakedUsd * a.yearlyAPR / 100;
      }
    }
    averageApr = averageApr / totalUserStaked;
    _print_bold(`Total Staked: $${formatMoney(totalStaked)}`);
    if (totalUserStaked > 0) {
      _print_bold(`\nYou are staking a total of $${formatMoney(totalUserStaked)} at an average APR of ${(averageApr * 100).toFixed(2)}%`)
      _print(`Estimated earnings:`
          + ` Day $${formatMoney(totalUserStaked*averageApr/365)}`
          + ` Week $${formatMoney(totalUserStaked*averageApr/52)}`
          + ` Year $${formatMoney(totalUserStaked*averageApr)}\n`);
    }
    return { prices, totalUserStaked, totalStaked, averageApr }
  
  */
  
