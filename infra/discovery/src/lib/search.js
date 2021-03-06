const elasticsearch = require('elasticsearch')
const get = require('lodash/get')

const scoring = require('../lib/scoring')
const logger = require('../listener/logger')

const client = new elasticsearch.Client({
  hosts: [process.env.ELASTICSEARCH_HOST || 'elasticsearch:9200'],
  // Pin the API version since we do not want to use the default as it changes
  // upon upgrade of the elasticsearch npm package and that may break things.
  apiVersion: '6.8'
})

// Elasticsearch index and type names for our data
// Elasticsearch is depreciating storing different types in the same index.
// (and forbids it unless you enable a special flag)
const LISTINGS_INDEX = 'listings'
const LISTINGS_TYPE = 'listing'

/**
 * Returns exchange rates of foreign currencies and tokens to USD.
 * Pulls the data from Redis. It's written to Redis by the bridge server.
 * @param {Array<string>} currencies - Currency values, format "token|fiat-XYZ". Ex: "token-ETH", "fiat-KRW"
 * @returns {Object} - Requested exchange rates, currency as key and rate as string value
 */
const getExchangeRatesToUSD = async currencies => {
  let exchangeRates = {}
  try {
    // lazy import to avoid event-listener depending on redis
    // this is only used in discovery
    const { getAsync } = require('../lib/redis')
    // TODO use redis batch features instead of promise.All
    const promises = currencies.map(currency => {
      const splitCurrency = currency.split('-')
      const resolvedCurrency = splitCurrency[1]
      if (resolvedCurrency === 'USD') {
        return '1'
      }
      return getAsync(`${resolvedCurrency}-USD_price`)
    })
    const result = await Promise.all(promises)
    result.forEach((r, i) => {
      if (r === null) {
        // Rate not present in Redis. Perhaps the bridge server is not pulling the rate for that currency ?
        logger.error(
          `Failed getting exchange rate for ${currencies[i]} from Redis. Check Bridge server.`
        )
      } else {
        exchangeRates[currencies[i]] = r
      }
    })
  } catch (e) {
    logger.error(
      'Error retrieving exchange rates from redis. Using defaults',
      e
    )
    exchangeRates = {
      'fiat-CNY': '0.14',
      'fiat-EUR': '1.12',
      'fiat-GBP': '1.22',
      'fiat-JPY': '0.0094',
      'fiat-KRW': '0.00082',
      'fiat-SGD': '0.72',
      'fiat-USD': '1.0',
      'token-DAI': '1.0',
      'token-ETH': '200.0'
    }
  }
  logger.debug('Exchange Rates - ', exchangeRates)
  return exchangeRates
}

class Cluster {
  /**
   * Gets cluster health and prints it.
   */
  static async health() {
    const resp = await client.cluster.health({})
    console.log('-- Search cluster health --\n', resp)
  }
}

class Listing {
  /**
   * Counts number of listings indexed.
   * @returns The number of listings indexed.
   */
  static async count() {
    const resp = await client.count({
      index: LISTINGS_INDEX,
      type: LISTINGS_TYPE
    })
    console.log(`Counted ${resp.count} listings in the search index.`)
    return resp.count
  }

  /**
   * Indexes a listing.
   * @param {string} listingId - The unique ID of the listing.
   * @param {string} buyerAddress - ETH address of the buyer.
   * @param {string} ipfsHash - 32 bytes IPFS hash, in hex (not base58 encoded).
   * @param {object} listing - JSON listing data.
   * @throws Throws an error if indexing operation failed.
   * @returns The listingId indexed.
   */
  static async index(listingId, buyerAddress, ipfsHash, listing) {
    // Create a copy of the listing object
    const listingToIndex = JSON.parse(JSON.stringify(listing))

    // commissionPerUnit is critical for calculating scoring.
    // Log a warning if that field is not populated - it is likely a bug.
    if (!listingToIndex.commissionPerUnit) {
      console.log(
        `WARNING: missing field commissionPerUnit on listing ${listingId}`
      )
    }

    // jCal fields are very dynamic and cause issues with ElasticSearch dynamic mappings.
    // Disabling indexing of those fields for now until we need to support search by availability.
    delete listingToIndex.ipfs
    delete listingToIndex.availability
    if (listingToIndex.offers) {
      listingToIndex.offers.forEach(offer => {
        delete offer.ipfs
        delete offer.timeSlots
      })
    }

    // Precompute score for listing
    const { scoreMultiplier } = await scoring.scoreListing(listingToIndex)
    listingToIndex.scoreMultiplier = scoreMultiplier

    await client.index({
      index: LISTINGS_INDEX,
      id: listingId,
      type: LISTINGS_TYPE,
      body: listingToIndex
    })
    return listingId
  }

  /**
   * Gets a single listing by id.
   * @param {string} id
   */
  static async get(id) {
    return client.get({
      index: LISTINGS_INDEX,
      type: LISTINGS_TYPE,
      id: id
    })
  }

  /**
   * Gets multiple listings by ids. Filters out non-visible listings.
   * @param {Array<string>} ids: listing ids.
   * @returns {Promise<Array<Object>>}
   */
  static async getByIds(ids) {
    const resp = await client.search({
      index: LISTINGS_INDEX,
      type: LISTINGS_TYPE,
      body: {
        query: {
          bool: {
            // Must match listing ids.
            must: { ids: { values: ids } },
            // Filter out non-visible listings.
            must_not: { terms: { scoreTags: ['Hide', 'Delete'] } }
          }
        }
      }
    })
    const listings = resp.hits.hits
    return listings.map(listing => listing._source)
  }

  /**
   * Updates the score tags and score for a listing.
   * Uses a small painless script that runs on the server to update the values.
   * This reduces the race condition window when two systems could be updating
   * the same listing at the same time. It also scales better.
   *
   * @param {string} id
   * @param {string[]} scoreTags
   */
  static async updateScoreTags(id, scoreTags) {
    const result = await client.get({
      index: LISTINGS_INDEX,
      type: LISTINGS_TYPE,
      id: id
    })
    const listing = result._source
    listing.scoreTags = scoreTags
    const { scoreMultiplier } = await scoring.scoreListing(result._source)
    listing.scoreMultiplier = scoreMultiplier
    const body = {
      script: {
        lang: 'painless',
        source: `
          ctx._source.scoreTags = params.scoreTags;
          ctx._source.scoreMultiplier = params.scoreMultiplier;
        `,
        params: {
          scoreTags: scoreTags,
          scoreMultiplier: scoreMultiplier
        }
      }
    }
    client.update({
      index: LISTINGS_INDEX,
      type: LISTINGS_TYPE,
      id: id,
      body
    })
    return listing
  }

  /**
   * Searches for listings.
   * @param {string} query - The search query.
   * @param {string} sort - The target value to sort on (can be object notation)
   * @param {string} order - The order of the sort
   * @param {array} filters - Array of filter objects
   * @param {integer} numberOfItems - number of items to display per page
   * @param {integer} offset - what page to return results from
   * @throws Throws an error if the search operation failed.
   * @returns A list of listings (can be empty).
   */
  static async search(query, sort, order, filters, numberOfItems, offset) {
    const currencies = [
      'fiat-CNY',
      'fiat-EUR',
      'fiat-GBP',
      'fiat-JPY',
      'fiat-KRW',
      'fiat-SGD',
      'fiat-USD',
      'token-DAI',
      'token-ETH'
    ]

    if (filters === undefined) {
      filters = []
    }
    const esQuery = {
      bool: {
        must: [],
        must_not: [
          {
            match: {
              status: 'withdrawn'
            }
          }
        ],
        should: [],
        filter: []
      }
    }

    // Never return any invalid listings
    esQuery.bool.must_not.push({
      term: { valid: false }
    })

    // Never return any listings moderated as hidden
    esQuery.bool.must_not.push({
      terms: {
        scoreTags: ['Hide', 'Delete']
      }
    })

    if (query !== undefined && query !== '') {
      // all_text is a field where all searchable fields get copied to
      esQuery.bool.must.push({
        match: {
          all_text: {
            query,
            fuzziness: 'AUTO',
            minimum_should_match: '-20%' // most query tokens must be in the listing
          }
        }
      })
      // give extra score if the search query matches in the title
      esQuery.bool.should.push({
        match: {
          title: {
            query: query,
            boost: 2,
            fuzziness: 'AUTO'
          }
        }
      })
      // give extra score for search words being in proximity to each other
      esQuery.bool.should.push({
        match_phrase: {
          all_text: {
            query: query,
            slop: 50
          }
        }
      })
    } else {
      esQuery.bool.must.push({ match_all: {} })
    }

    /* interestingly JSON.stringify performs pretty well:
     * https://stackoverflow.com/questions/122102/what-is-the-most-efficient-way-to-deep-clone-an-object-in-javascript/5344074#5344074
     */
    const esAggregationQuery = JSON.parse(JSON.stringify(esQuery))

    filters.forEach(filter => {
      let innerFilter = {}

      if (filter.operator === 'GREATER_OR_EQUAL') {
        innerFilter = {
          range: {
            [filter.name]: {
              gte: filter.value
            }
          }
        }
      } else if (filter.operator === 'LESSER_OR_EQUAL') {
        innerFilter = {
          range: {
            [filter.name]: {
              lte: filter.value
            }
          }
        }
      } else if (
        filter.operator === 'CONTAINS' &&
        filter.valueType === 'ARRAY_STRING'
      ) {
        innerFilter = {
          bool: {
            should: filter.value.split(',').map(singleValue => {
              return { term: { [filter.name]: singleValue } }
            })
          }
        }
      } else if (filter.operator === 'EQUALS') {
        innerFilter = { term: { [filter.name]: filter.value } }
      }

      esQuery.bool.filter.push(innerFilter)
    })

    // All non-time based scoring is statically computed ahead of time and
    // index in a listing's `scoreMultiplier` field
    const scoreQuery = {
      function_score: {
        query: esQuery,

        script_score: {
          script: {
            params: {
              // Strongly reccomended to pass date in as a paramter since:
              // - All nodes in an elastic search cluster will be using the same value
              // - Script itself stays the same, and never needs to be recompiled
              now: new Date().getTime()
            },
            source: `double score = _score;

            if(doc.containsKey('scoreMultiplier') && doc['scoreMultiplier'] != null){
              score *= doc['scoreMultiplier'].value
            }

            // Temporary boost for recently created listings.
            // linear reduction in boost off during boost period.
            if (doc['createdEvent.timestamp'] != null) {
              double recentBoostAmount = 0.5;
              long boostPeriod = 18 * 24 * 60 * 60;
              long age = params.now - doc['createdEvent.timestamp'].value;
              if (age > 0 && age < boostPeriod) {
                score *= 1.0 + ((double)age / (double)boostPeriod) * recentBoostAmount;
              }
            }
            
            return score;
            `
          }
        }
      }
    }

    // FIXME: This is temporary while switching DApp to use
    // a paginated interface to fetch listings.
    if (numberOfItems === -1) {
      numberOfItems = 1000
    }

    /**
     * Creates sort query
     * @returns {Object} - Sort query for elastic search
     */
    const getSortQuery = async () => {
      const exchangeRates = await getExchangeRatesToUSD(currencies)

      const sortWhiteList = ['price.amount']
      const orderWhiteList = ['asc', 'desc']
      // if sort and order are set, return a sort
      // otherwise return empty sort to skip
      if (sort && sort.length > 0 && order && order.length > 0) {
        try {
          // check that sort and order are approved values
          if (sortWhiteList.includes(sort) && orderWhiteList.includes(order)) {
            switch (sort) {
              // script based sorting specifically for calculating price based on exchange rate
              case 'price.amount':
                return {
                  _script: {
                    type: 'number',
                    script: {
                      lang: 'painless',
                      // Note: Wrap calculation in a try/catch statement to be robust to possibly
                      // malformed listings that exist on testing environments and could also exist in production.
                      source: `
                        try {
                          float amount = Float.parseFloat(params._source.price.amount);
                          float rate = Float.parseFloat(params.exchangeRates[params._source.price.currency.id]);
                          return amount * rate;
                        } catch (Exception e) {
                          return params.order == "asc" ? 1000000000L : 0;
                        }`,
                      params: {
                        order: order,
                        exchangeRates: exchangeRates
                      }
                    },
                    order: order
                  }
                }
              default:
                // this default is for non script based sorting, should satisfy most cases
                return [
                  {
                    [sort]: {
                      order: order
                    }
                  }
                ]
            }
          } else {
            throw new Error(
              `Sort variables are not whitelisted - sort = ${sort}, order = ${order}, disabling sorting`
            )
          }
        } catch (e) {
          logger.error(e)
          return []
        }
      } else {
        return []
      }
    }

    const searchRequest = client.search({
      index: LISTINGS_INDEX,
      type: LISTINGS_TYPE,
      body: {
        from: offset,
        size: numberOfItems,
        query: scoreQuery,
        sort: await getSortQuery(),
        _source: [
          'title',
          'description',
          'price',
          'commissionPerUnit',
          'scoreMultiplier',
          'scoreTags'
        ]
      }
    })

    const aggregationRequest = client.search({
      index: LISTINGS_INDEX,
      type: LISTINGS_TYPE,
      body: {
        query: esAggregationQuery,
        _source: ['_id'],
        aggs: {
          max_price: { max: { field: 'price.amount' } },
          min_price: { min: { field: 'price.amount' } }
        }
      }
    })

    const [searchResponse, aggregationResponse] = await Promise.all([
      searchRequest,
      aggregationRequest
    ])
    const listings = []
    searchResponse.hits.hits.forEach(hit => {
      listings.push({
        id: hit._id,
        title: hit._source.title,
        category: hit._source.category,
        subCategory: hit._source.subCategory,
        description: hit._source.description,
        price: {
          amount: get(hit, '_source.price.amount', '0'),
          currency: get(hit, '_source.price.currency.id', 'fiat-USD')
        }
      })
    })

    const maxPrice = aggregationResponse.aggregations.max_price.value
    const minPrice = aggregationResponse.aggregations.min_price.value
    const stats = {
      maxPrice: maxPrice || 0,
      minPrice: minPrice || 0,
      totalNumberOfListings: searchResponse.hits.total
    }
    logger.debug('search listings - ', listings)
    return { listings, stats }
  }
}

module.exports = {
  Cluster,
  Listing
}
