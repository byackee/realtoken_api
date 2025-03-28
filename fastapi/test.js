import { createPublicClient, http } from 'viem';

// Définition d'une ABI minimale pour la fonction à appeler
const contractAbi = [
  {
    inputs: [
      {
        internalType: 'address',
        name: 'user',
        type: 'address',
      },
    ],
    name: 'getAllTokenBalancesOfUser',
    outputs: [
      {
        internalType: 'address[]',
        name: '',
        type: 'address[]',
      },
      {
        internalType: 'uint256[]',
        name: '',
        type: 'uint256[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

// Adresse du contrat RealTokenWrapper (à modifier)
const CONTRACT_ADDRESS = '0xYourContractAddress';

// Adresse du wallet à interroger
const WALLET_ADDRESS = '0x6c35b4f5f62b5c2c0e031a17ffae0b889e4dbdce';

// Création du client public en spécifiant le RPC officiel de Gnosis Chain
const client = createPublicClient({
  chain: {
    id: 100,
    name: 'Gnosis',
    network: 'gnosis',
    nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
    rpcUrls: { default: { http: ['https://rpc.gnosischain.com'] } },
  },
  transport: http('https://rpc.gnosischain.com'),
});

// Fonction asynchrone pour lire la fonction getAllTokenBalancesOfUser
async function getAllTokenBalances() {
  try {
    const result = await client.readContract({
      address: CONTRACT_ADDRESS,
      abi: contractAbi,
      functionName: 'getAllTokenBalancesOfUser',
      args: [WALLET_ADDRESS],
    });
    
    // result est un tuple [address[], uint256[]]
    console.log('Liste des tokens :', result[0]);
    console.log('Balances correspondantes :', result[1]);
  } catch (error) {
    console.error('Erreur lors de la récupération des soldes :', error);
  }
}

getAllTokenBalances();
