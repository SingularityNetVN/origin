import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStoreState } from 'pullstate'
import { ethers } from 'ethers'
import { get } from 'lodash'
import axios from 'axios'
import ipfsClient from 'ipfs-http-client'
import bs58 from 'bs58'

import { baseListing } from '@/constants'
import contracts from '@/constants/contracts'
import store from '@/store'

const API_URL = process.env.API_URL || 'http://localhost:3000'

const Deploy = () => {
  const [email, setEmail] = useState('')
  const [step, setStep] = useState('Email')
  const [password, setPassword] = useState('')

  const settings = useStoreState(store, s => s.settings)
  const backendUrl = settings.backend
  const ethNetworkId = Number(web3.currentProvider.chainId)
  const config = contracts[ethNetworkId]

  /* Check if a user has an account on the backend,
   */
  const handleEmail = () => {
    const response = axios.get(backendUrl, { email })
    if (response.status === 204) {
      setStep('Password')
    } else {
      setStep('Password')
    }
  }

  /* If a user already has an account on the backend, they will be logged in. If
   * a user does not have account one will be created and they will be logged in.
   */
  const handlePassword = () => {
    const response = axios.post(backendUrl, { email, password} )

    const listingId = get(settings.networks, `${ethNetworkId}.listingId`)
    if (!listingId) {
      setStep('Listing')
    } else {
      setStep('Summary')
    }
  }

  /* Create a listing on the Origin Marketplace contract
   *
   */
  const createListing = async () => {
    if (!config) {
      console.error(`No configuration for network`, ethNetworkId)
      return
    }

    if (!window.ethereum) return
    await window.ethereum.enable()
    const provider = new ethers.providers.Web3Provider(window.ethereum)

    const ipfs = ipfsClient(process.env.IPFS_API_URL)

    const signer = provider.getSigner(0)
    const abi = [
      'event ListingCreated (address indexed party, uint indexed listingID, bytes32 ipfsHash)',
      'function createListing(bytes32, uint256, address)'
    ]
    const marketplaceContract = new ethers.Contract(
      config['Marketplace_V01'],
      abi,
      signer
    )
    const listing = {
      ...baseListing,
      title: settings.title,
      description: settings.title
    }

    const response = await ipfs.add(Buffer.from(JSON.stringify(listing)))
    const bytes32Hash = `0x${bs58
      .decode(response[0].hash)
      .slice(2)
      .toString('hex')}`
    await marketplaceContract.createListing(bytes32Hash, 0, config.arbitrator)

    // Wait for ListingCreated event to get listingID
    // Event filter for ListingCreated event with the same IPFS hash, ignore other
    // parameters
    const eventFilter = marketplaceContract.filters.ListingCreated(
      signer._address,
      null,
      null
    )

    const eventPromise = new Promise(resolve => {
      marketplaceContract.on(eventFilter, (party, listingId, ipfsHash) => {
        console.debug(`Created listing ${listingId} ${ipfsHash}`)
        resolve(`${ethNetworkId}-001-${Number(listingId)}`)
      })
    })

    return eventPromise
  }

  const renderEmailForm = () => {
    return (
      <>
        <div className="my-5">
          <p>Great! You've elected to use Origin's hosted backend to deliver email notifications and manage orders and discounts (if you'd prefer to host it yourself, please refer to the documentation).</p>

          <p>Please enter the email address you'd like to use for DShop related notifications. If we find you've already got an account, we'll use that, otherwise we'll create one for you.</p>
        </div>

        <form className="mt-3" onSubmit={handleEmail}>
          <div className="form-group">
            <label>Email</label>
            <input
              className="form-control input-lg"
              onChange={e => setEmail(e.target.value)}
              value={email}
              placeholder="Email address"
            />
          </div>
          <div className="mt-5">
            <button type="submit" className="btn btn-lg btn-primary">
              Continue
            </button>
          </div>
        </form>
      </>
    )
  }

  const renderPasswordForm = () => {
    return (
      <>
        <div className="my-5">
          <p>Please enter your password</p>
        </div>

        <form className="mt-3" onSubmit={handlePassword}>
          <div className="form-group">
            <label>Password</label>
            <input
              className="form-control input-lg"
              onChange={e => setPassword(e.target.value)}
              value={email}
              placeholder="Password"
            />
          </div>
          <div className="mt-5">
            <button type="submit" className="btn btn-lg btn-primary">
              Continue
            </button>
          </div>
        </form>
      </>
    )
  }

  const renderListingForm = () => {
    return (
      <div className="my-5">
        <p>Now we will create a listing on the Origin marketplace contract for your DShop. You'll be prompted to sign a transaction in MetaMask.</p>
        <div className="mt-5">
          <button onClick={createListing} className="btn btn-lg btn-primary">
            Continue
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="d-flex justify-content-between">
        <h3>Deploy</h3>
      </div>

      {step === 'Email' && renderEmailForm()}
      {step === 'Password' && renderPasswordForm()}
      {step === 'Listing' && renderListingForm()}
    </>
  )
}

export default Deploy

require('react-styl')(`
`)
