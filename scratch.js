const axios = require('axios').default
const t1 = require('./tokens1.js')
const t137 = require('./tokens137.js')
const t56 = require('./tokens56.js')
const t10 = require('./tokens10.js')

const ethers = require('ethers')
const fs = require('fs')

const BN = ethers.BigNumber
const formatUnits = ethers.utils.formatUnits
const parseUnits = ethers.utils.parseUnits

function chainIdToName(id) {
    const chainmap = {1:'eth', 10:'optimism', 56:'binance', 137:'matic'}
    return chainmap[id]
}

function chainNameToId(name) {
    const chainmap = {eth:1, optimism:10,binance:56, matic:137}
    return chainmap[name]
}

function findTkn(tknSymbol, chainId) {
    let result = null
    let tokens = []
    if (chainId === 1) tokens = t1.TokensDB.tokens
    if (chainId === 10) tokens = t10.TokensDB.tokens
    if (chainId === 56) tokens = t56.TokensDB.tokens
    if (chainId === 137) tokens = t137.TokensDB.tokens

    for (var value in tokens) { if (tknSymbol.toUpperCase() === tokens[value].symbol) result = tokens[value] }
    return result
}

async function get1InchPrice(tknFrom, tknTo, amt, chainId) { //returns a promise with json result

    const params = new URLSearchParams({
        fromTokenAddress: tknFrom.address,
        toTokenAddress: tknTo.address,
        amount: parseUnits(amt.toString(), tknFrom.decimals) 
    })
    
    const resp = await axios.get( `https://api.1inch.exchange/v3.0/${chainId}/quote?` + params )
    const price = amt / formatUnits(resp.data.toTokenAmount, resp.data.toToken.decimals) 
    return {price, data:resp.data}
}

async function quotes(fromSym, toSym, chains, fromAmts, invPrice) {
// e.g. buyQuotes('USDC', 'ETH', [1,10,56,137], [100, 1000, 10000, 100000], false)

    let quoteReqs = fromAmts.map(fromAmt =>
     chains.map(chainId => {return {chainId, fromAmt, quoteReq:get1InchPrice(findTkn(fromSym,chainId), findTkn(toSym,chainId), fromAmt, chainId)}})).flat()

    return await Promise.all(quoteReqs.map(async req => {
        const quote = await req.quoteReq
        let price = quote.price
        if (invPrice) price = 1 / quote.price
        return {chainId: req.chainId, fromAmt: req.fromAmt, price, data:quote.data}
    }))

}

async function getGasAllChain() {

    const rpcs = ['https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161', 'https://mainnet.optimism.io','https://bsc-dataseed1.binance.org/','https://polygon-rpc.com/']

    const providers = rpcs.map(rpc=>new ethers.providers.JsonRpcProvider(rpc))
    const gasReqs = providers.map(provider => provider.getGasPrice())
    const gass = await Promise.all(gasReqs)

    return {eth:gass[0], optimism:gass[1], binance:gass[2], matic:gass[3] }
}

async function getPricesAllChains() {
// get current eth, matic and bnb prices from coingecko in USD

    const priceReq = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,matic-network,binancecoin&vs_currencies=USD'
    let httpData = await axios.get(priceReq)

    return {eth:httpData.data.ethereum.usd,
            optimism: httpData.data.ethereum.usd,
            binance:httpData.data.binancecoin.usd,
            matic:httpData.data['matic-network'].usd }
}

async function bidsAndAsksETH(priceList){
    const gasPrices = await getGasAllChain()
    const chainPrices = await getPricesAllChains()
    const asks = quotes('USDC', 'ETH', [1,10,56,137], [100, 1000, 10000, 100000], false)
    const bids = quotes('ETH', 'USDC', [1,10,56,137], [0.025, 0.25, 2.5, 25], true)
    //const newPrices =  await Promise.all([{side:'ASKS', quotes:await asks}, {side:'BIDS', quote:await bids}])
    const newPrices =  {askQuote:await asks, bidQuote:await bids}
    const newEntry = {time:new Date().toLocaleString(), instr:'ETH', gasPrices, chainPrices, newPrices}
    priceList.push(newEntry)
    return priceList
}


function sleep(ms) {return new Promise(resolve => setTimeout(resolve, ms))}

async function runMany(num, msDelay, f) {
    let env = await getEnv()
    for (let i = 0; i < num; i++) {
        let delay = msDelay
        try {await f(env)}
        catch (err) {console.log(`ERROR Found: ${err}`); delay = delay * 2}
        console.log(`done loop ${i}`)
        await sleep(delay)
    }
}


async function runManyParam(num, msDelay, f, initParam) {
    let param = initParam
    for (let i = 0; i < num; i++) {
        let delay = msDelay
        try {param = await f(param)}
        catch (err) {console.log(`ERROR Found: ${err}`); delay = delay * 2}
        console.log(`done loop ${i}`)
        await sleep(delay)
    }
    return param
}

function writeToFile(res) {
    fs.writeFileSync('./hourdata.json', JSON.stringify(res))
}

function loadFromFile() {
    return JSON.parse(fs.readFileSync('./hourdata.json', 'utf8'))    
}

function writeToNamedFile(res, fileName) {
    fs.writeFileSync(fileName, JSON.stringify(res))
}

function loadFromNamedFile(filename) {
    return JSON.parse(fs.readFileSync(filename, 'utf8'))    
}

/*
res = await runManyParam(60, 60000, bidsAndAsksETH, [])

fs.writeFileSync('./hourdata.json', JSON.stringify(res))
res = JSON.parse(fs.readFileSync('./hourdata.json', 'utf8'))


res[0].newPrices.askQuote.map((askQuote, i) => askQuote.price - res[0].newPrices.bidQuote[i].price)

*/

//convert to an array of arrays
// time stamp
// 8 spread arrays for each chain and amt
// 

function processOne(resPrices, curMid) {
    return resPrices.askQuote.map((askQuote, i) => {
        const bidQuote = resPrices.bidQuote[i]
        const midPrice = (askQuote.price + bidQuote.price) /2
        const midDiffBP = (curMid - midPrice) / midPrice * 10000
        const spreadBP = (askQuote.price - bidQuote.price) / midPrice * 10000
        return{ chainId: askQuote.chainId, fromAmt:askQuote.fromAmt, midPrice, spreadBP, midDiffBP}
    })
}

function processOneGas(oneRes) {
    // adjust the bid and ask prices according to the gas price and cost.
    // get the dollar gasPrice for each chain.
    const chains = ['eth', 'optimism', 'binance','matic']
    const gasDolPrices = chains.map(chain => formatUnits(BN.from(oneRes.gasPrices[chain]).toString(),18) * oneRes.chainPrices[chain])
    const chainIdGasPrice = {1:gasDolPrices[0],10:gasDolPrices[1], 56:gasDolPrices[2],137:gasDolPrices[3] }

    return oneRes.newPrices.askQuote.map((askQuote, i) => {

        const askGasPrice = chainIdGasPrice[askQuote.chainId] * askQuote.data.estimatedGas /askQuote.fromAmt
        const bidQuote = oneRes.newPrices.bidQuote[i]
        const bidGasPrice = chainIdGasPrice[bidQuote.chainId] * bidQuote.data.estimatedGas/askQuote.fromAmt
        const midPrice = (askQuote.price + bidQuote.price) /2
        const midDiffBP = (oneRes.chainPrices.eth - midPrice) / midPrice * 10000
        const spreadBP = ((askQuote.price*(1+ askGasPrice)) -(bidQuote.price*(1-bidGasPrice))) / midPrice * 10000
        return{ chainId: askQuote.chainId, fromAmt:askQuote.fromAmt, midPrice, spreadBP, midDiffBP, askGasPrice, bidGasPrice, gasPrice: chainIdGasPrice[askQuote.chainId]}
    })
}

function processResults(res) {
// ok so here we are going to process the results
// 1. calculate the spread for each of the chains and sizes
//   a. output array of spreads for each chain and size 
//   b. output the average spread for each chain and size <-- main results

    const combs = [{chainId:1, fromAmt:100}, {chainId:1, fromAmt:1000},{chainId:1, fromAmt:10000},{chainId:1, fromAmt:100000},
                   {chainId:10, fromAmt:100}, {chainId:10, fromAmt:1000},{chainId:10, fromAmt:10000},{chainId:10, fromAmt:100000},
                   {chainId:56, fromAmt:100}, {chainId:56, fromAmt:1000},{chainId:56, fromAmt:10000},{chainId:56, fromAmt:100000},
                   {chainId:137, fromAmt:100}, {chainId:137, fromAmt:1000},{chainId:137, fromAmt:10000},{chainId:137, fromAmt:100000}]

    const resP = res.map(item => processOne(item.newPrices, item.chainPrices.eth))
    const resPT = combs.map(key => resP.map(itemL => itemL.filter(item => item.chainId === key.chainId && item.fromAmt === key.fromAmt)[0]))
    const resPTAvgEth = resPT.slice(0,4)[0].map((first,i) => (first.spreadBP + resPT.slice(0,4)[1][i].spreadBP + resPT.slice(0,4)[2][i].spreadBP + resPT.slice(0,4)[3][i].spreadBP)/4)
    const resPTAvgOpt = resPT.slice(4,8)[0].map((first,i) => (first.spreadBP + resPT.slice(4,8)[1][i].spreadBP + resPT.slice(4,8)[2][i].spreadBP + resPT.slice(4,8)[3][i].spreadBP)/4)
    const resPTAvgBin = resPT.slice(8,12)[0].map((first,i) => (first.spreadBP + resPT.slice(8,12)[1][i].spreadBP + resPT.slice(8,12)[2][i].spreadBP + resPT.slice(8,12)[3][i].spreadBP)/4)
    const resPTAvgMat = resPT.slice(12,16)[0].map((first,i) => (first.spreadBP + resPT.slice(12,16)[1][i].spreadBP + resPT.slice(12,16)[2][i].spreadBP +resPT.slice(12,16)[3][i].spreadBP)/4)
    const avgs = resPT.map(prices =>  prices.reduce((acc,next) => acc+next.spreadBP,0)/prices.length)

    const resPG = res.map(item => processOneGas(item))
    const resPGT = combs.map(key => resPG.map(itemL => itemL.filter(item => item.chainId === key.chainId && item.fromAmt === key.fromAmt)[0]))
    const resPGTAvgEth = resPGT.slice(0,4)[0].map((first,i) => (first.spreadBP+resPGT.slice(0,4)[1][i].spreadBP+resPGT.slice(0,4)[2][i].spreadBP +resPGT.slice(0,4)[3][i].spreadBP)/4)
    const resPGTAvgOpt = resPGT.slice(4,8)[0].map((first,i) => (first.spreadBP+resPGT.slice(4,8)[1][i].spreadBP+resPGT.slice(4,8)[2][i].spreadBP +resPGT.slice(4,8)[3][i].spreadBP)/4)
    const resPGTAvgBin = resPGT.slice(8,12)[0].map((first,i) => (first.spreadBP+resPGT.slice(8,12)[1][i].spreadBP+resPGT.slice(8,12)[2][i].spreadBP +resPGT.slice(8,12)[3][i].spreadBP)/4)
    const resPGTAvgMat = resPGT.slice(12,16)[0].map((first,i) => (first.spreadBP+resPGT.slice(12,16)[1][i].spreadBP+resPGT.slice(12,16)[2][i].spreadBP +resPGT.slice(12,16)[3][i].spreadBP)/4)

    const avgsG = resPGT.map(prices =>  prices.reduce((acc,next) => acc+next.spreadBP,0)/prices.length)

    const times = res.map(item=> item.time)

    return {times, noGas: {avgs, resPT, resPTAvgEth, resPTAvgOpt, resPTAvgBin, resPTAvgMat}, gas: {avgsG, resPGT,resPGTAvgEth, resPGTAvgOpt, resPGTAvgBin, resPGTAvgMat}}

}

