import {
  Hex,
  PrivateKeyAccount,
  PublicClient,
  createPublicClient,
  http,
  createClient,
  HttpTransport,
  Address
} from 'viem'
import { EIP155Wallet } from '../EIP155Lib'
import { JsonRpcProvider } from '@ethersproject/providers'
import { privateKeyToAccount } from 'viem/accounts'
import {
  PimlicoPaymasterClient,
  createPimlicoPaymasterClient
} from 'permissionless/clients/pimlico'
import {
  BundlerActions,
  BundlerClient,
  ENTRYPOINT_ADDRESS_V06,
  ENTRYPOINT_ADDRESS_V07,
  SmartAccountClient,
  SmartAccountClientConfig,
  bundlerActions,
  createSmartAccountClient,
  isSmartAccountDeployed
} from 'permissionless'
import { PimlicoBundlerActions, pimlicoBundlerActions } from 'permissionless/actions/pimlico'
import { PIMLICO_NETWORK_NAMES, UrlConfig, publicRPCUrl } from '@/utils/SmartAccountUtil'
import { Chain } from '@/consts/smartAccounts'
import { EntryPoint } from 'permissionless/types/entrypoint'
import { foundry } from 'viem/chains'

type SmartAccountLibOptions = {
  privateKey: string
  chain: Chain
  sponsored?: boolean
  entryPointVersion?: number
}

export abstract class SmartAccountLib implements EIP155Wallet {
  // Options
  public chain: Chain
  public sponsored: boolean = true
  public entryPoint: EntryPoint

  // Signer
  protected signer: PrivateKeyAccount
  #signerPrivateKey: string

  // Clients
  protected publicClient: PublicClient
  protected paymasterClient: PimlicoPaymasterClient<EntryPoint>
  protected bundlerClient: BundlerClient<EntryPoint> &
    BundlerActions<EntryPoint> &
    PimlicoBundlerActions
  protected client: (SmartAccountClient<EntryPoint> & PimlicoBundlerActions) | undefined

  // Transport
  protected bundlerUrl: HttpTransport
  protected paymasterUrl: HttpTransport

  // Utility
  public type: string
  public initialized = false

  public constructor({
    privateKey,
    chain,
    sponsored = false,
    entryPointVersion = 6
  }: SmartAccountLibOptions) {
    const apiKey = process.env.NEXT_PUBLIC_PIMLICO_KEY
    const publicClientRPCUrl = process.env.NEXT_PUBLIC_LOCAL_CLIENT_URL || publicRPCUrl({ chain })
    const paymasterUrl = ({ chain }: UrlConfig) => {
      const localPaymasterUrl = process.env.NEXT_PUBLIC_LOCAL_PAYMASTER_URL
      if (localPaymasterUrl) {
        return localPaymasterUrl
      }
      return `https://api.pimlico.io/v2/${PIMLICO_NETWORK_NAMES[chain.name]}/rpc?apikey=${apiKey}`
    }

    const bundlerUrl = ({ chain }: UrlConfig) => {
      const localBundlerUrl = process.env.NEXT_PUBLIC_LOCAL_BUNDLER_URL
      if (localBundlerUrl) {
        return localBundlerUrl
      }
      return `https://api.pimlico.io/v1/${PIMLICO_NETWORK_NAMES[chain.name]}/rpc?apikey=${apiKey}`
    }

    let entryPoint: EntryPoint = ENTRYPOINT_ADDRESS_V06
    if (entryPointVersion === 7) {
      entryPoint = ENTRYPOINT_ADDRESS_V07
    }
    this.entryPoint = entryPoint

    this.chain = chain
    this.sponsored = sponsored
    this.#signerPrivateKey = privateKey
    this.signer = privateKeyToAccount(privateKey as Hex)

    this.bundlerUrl = http(bundlerUrl({ chain: this.chain }))
    this.paymasterUrl = http(paymasterUrl({ chain: this.chain }))

    this.publicClient = createPublicClient({
      transport: http(publicClientRPCUrl)
    }).extend(bundlerActions(this.entryPoint))

    this.paymasterClient = createPimlicoPaymasterClient({
      transport: this.paymasterUrl,
      entryPoint: this.entryPoint,
      chain: this.chain
    })

    this.bundlerClient = createClient({
      transport: this.bundlerUrl,
      chain: this.chain
    })
      .extend(bundlerActions(this.entryPoint))
      .extend(pimlicoBundlerActions(this.entryPoint))

    const name = this.constructor.name.replace('SmartAccountLib', '')
    this.type = name && name.length > 0 ? name : 'Unknown'
  }

  abstract getClientConfig(): Promise<SmartAccountClientConfig<EntryPoint>>

  async init() {
    const config = await this.getClientConfig()
    this.client = createSmartAccountClient(config).extend(pimlicoBundlerActions(this.entryPoint))
    console.log('Smart account initialized', {
      address: this.client.account?.address,
      chain: this.chain.name,
      type: this.type
    })
    this.initialized = true
  }

  getMnemonic(): string {
    throw new Error('Method not implemented.')
  }
  getPrivateKey(): string {
    return this.#signerPrivateKey
  }
  getAddress(): string {
    if (!this.client) {
      throw new Error('Client not initialized')
    }
    return this.client.account?.address || ''
  }
  async signMessage(message: string): Promise<string> {
    if (!this.client) {
      throw new Error('Client not initialized')
    }
    const signature = await this.client.account?.signMessage({ message })
    return signature || ''
  }
  async _signTypedData(
    domain: any,
    types: any,
    data: any,
    _primaryType?: string | undefined
  ): Promise<string> {
    if (!this.client) {
      throw new Error('Client not initialized')
    }
    console.log('Signing typed data with Smart Account', { type: this.type, domain, types, data })
    const primaryType = _primaryType || ''
    const signature = await this.client.account?.signTypedData({
      domain,
      types,
      primaryType,
      message: data
    })
    return signature || ''
  }
  connect(_provider: JsonRpcProvider): any {
    if (!this.client) {
      throw new Error('Client not initialized')
    }
    return this
  }
  async signTransaction(transaction: any): Promise<string> {
    if (!this.client || !this.client.account) {
      throw new Error('Client not initialized')
    }
    const signature = await this.client.account.signTransaction(transaction)
    return signature || ''
  }
  async sendTransaction({ to, value, data }: { to: Address; value: bigint; data: Hex }) {
    if (!this.client || !this.client.account) {
      throw new Error('Client not initialized')
    }
    const txResult = await this.client.sendTransaction({
      to,
      value,
      data,
      account: this.client.account,
      chain: this.chain
    })

    return txResult
  }

  async sendBatchTransaction(
    args: {
      to: Address
      value: bigint
      data: Hex
    }[]
  ) {
    console.log('Sending transaction from smart account', { type: this.type, args })
    if (!this.client || !this.client.account) {
      throw new Error('Client not initialized')
    }

    const userOp = await this.client.prepareUserOperationRequest({
      userOperation: {
        callData: await this.client.account.encodeCallData(args)
      },
      account: this.client.account
    })

    const newSignature = await this.client.account.signUserOperation(userOp)
    console.log('Signatures', { old: userOp.signature, new: newSignature })

    userOp.signature = newSignature

    const userOpHash = await this.bundlerClient.sendUserOperation({
      userOperation: userOp
    })
    return userOpHash
  }

  getAccount() {
    if (!this.client?.account) {
      throw new Error('Client not initialized')
    }
    return this.client.account
  }
}
