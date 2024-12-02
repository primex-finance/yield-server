const sdk = require('@defillama/sdk');
const superagent = require('superagent');
const { abi } = require('./abi');
const {
  CHAIN_IDS,
  DEAD_ADDRESS,
  ROLES,
  SECONDS_PER_YEAR,
  APY_REWARD_BONUS,
  config,
  configV2,
  addressEq,
  getPoolUrl,
} = require('./utils');

const formatPool = async (bucket, config, EPMXPrice) => {
  const {
    bucketAddress,
    asset,
    supportedAssets,
    supply,
    demand,
    bar,
    lar,
    estimatedBar,
    estimatedLar,
    miningParams,
    name,
  } = bucket;
  const { chain, EPMX, USDCE, apyRewardBySymbol } = config;

  const symbol = addressEq(asset.tokenAddress, USDCE) ? 'USDC.E' : asset.symbol;
  const underlyingTokens = [asset.tokenAddress];

  const priceKeys = underlyingTokens
    .map((t) => `${chain.toLowerCase()}:${t}`)
    .join(',');
  const prices = (
    await superagent.get(`https://coins.llama.fi/prices/current/${priceKeys}`)
  ).body.coins;

  const assetPrice = prices[`${chain.toLowerCase()}:${asset.tokenAddress}`];
  const totalSupplyUsd =
    (supply / 10 ** assetPrice.decimals) * assetPrice.price;
  const totalBorrowUsd =
    (demand / 10 ** assetPrice.decimals) * assetPrice.price;
  const tvlUsd = totalSupplyUsd - totalBorrowUsd;

  const isMiningPhase =
    !miningParams.isBucketLaunched &&
    miningParams.deadlineTimestamp * 1000 > Date.now();

  const apyBaseCalculated =
    (Math.pow(1 + lar / 10 ** 27 / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1) *
    100;
  const apyBase = isMiningPhase ? 0 : apyBaseCalculated;

  const apyBaseBorrowCalculated =
    (Math.pow(1 + bar / 10 ** 27 / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1) *
    100;
  const apyBaseBorrow = isMiningPhase ? 0 : apyBaseBorrowCalculated;
  const apyReward = isMiningPhase ? APY_REWARD_BONUS : 0;
  const apyRewardBorrow = 0;

  return {
    pool: `${bucketAddress}-${chain}`.toLowerCase(),
    chain,
    project: 'primex-finance',
    symbol,
    tvlUsd,
    apyBase,
    apyReward,
    rewardTokens: [EPMX],
    underlyingTokens,
    url: getPoolUrl(bucketAddress, chain),
    apyBaseBorrow,
    apyRewardBorrow,
    totalSupplyUsd,
    totalBorrowUsd,
  };
};

const getPools = async (config) => {
  const {
    chain,
    lensAddress,
    bucketsFactory,
    positionManager,
    EPMX,
    EPMXPriceFeed,
    EPMXPriceFeedDecimals,
  } = config;

  const buckets = (
    await sdk.api.abi.call({
      abi: abi.getAllBucketsFactory,
      target: lensAddress,
      chain: chain.toLowerCase(),
      params: [bucketsFactory, DEAD_ADDRESS, positionManager, false],
    })
  ).output;

  const EPMXPrice =
    (
      await sdk.api.abi.call({
        abi: abi.getChainlinkLatestRoundData,
        target: lensAddress,
        chain: chain.toLowerCase(),
        params: [[EPMXPriceFeed]],
      })
    ).output[0].answer /
    10 ** EPMXPriceFeedDecimals;

  return await Promise.all(
    buckets
      .filter(({ miningParams }) => {
        const isMiningFailed =
          !miningParams.isBucketLaunched &&
          miningParams.deadlineTimestamp * 1000 <= Date.now();

        return !isMiningFailed;
      })
      .map((b) => formatPool(b, config, EPMXPrice))
  );
};

const getApy = async (conf) => {
  return (await Promise.all(conf.map((c) => getPools(c)))).flat();
};

const getApyCombined = async (config1, config2) => {
  try {
    const [apy1, apy2] = await Promise.all([getApy(config1), getApy(config2)]);

    return [...apy1, ...apy2];
  } catch (error) {
    console.error('Error fetching APY:', error);
    return [];
  }
};

module.exports = {
  timetravel: false,
  apy: async () => {
    const combinedApy = await getApyCombined(config, configV2);
    return combinedApy;
  },
};
