// Exemple d'utilisation de viem pour interagir avec Ethereum
const { createPublicClient, http } = require('viem');
const { mainnet } = require('viem/chains');

// Création d'un client public pour interagir avec Ethereum mainnet
const client = createPublicClient({
  chain: mainnet,
  transport: http('https://eth-mainnet.g.alchemy.com/v2/demo')
});

async function getEthereumInfo() {
  console.log('📊 Récupération des informations Ethereum...');

  try {
    // Récupérer le bloc le plus récent
    const blockNumber = await client.getBlockNumber();
    console.log(`✅ Numéro du bloc actuel: ${blockNumber}`);

    // Récupérer les détails du bloc
    const block = await client.getBlock({ blockNumber });
    console.log(`✅ Bloc #${blockNumber}:`);
    console.log(`   - Hash: ${block.hash}`);
    console.log(`   - Timestamp: ${new Date(Number(block.timestamp) * 1000).toLocaleString('fr-FR')}`);
    console.log(`   - Transactions: ${block.transactions.length}`);
    console.log(`   - Taille: ${block.size} bytes`);

    // Récupérer le prix du gaz
    const gasPrice = await client.getGasPrice();
    console.log(`✅ Prix du gaz actuel: ${Number(gasPrice) / 1e9} Gwei`);

    // Récupérer la balance d'une adresse connue (Vitalik Buterin)
    const vitalikAddress = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
    const balance = await client.getBalance({ address: vitalikAddress });
    console.log(`✅ Balance de Vitalik (${vitalikAddress}): ${Number(balance) / 1e18} ETH`);

  } catch (error) {
    console.error('❌ Erreur lors de la récupération des informations Ethereum:', error.message);
  }
}

// Exécuter la fonction principale
(async () => {
  console.log('🚀 Démarrage du script de vérification Ethereum');
  await getEthereumInfo();
  console.log('🏁 Script terminé');
})(); 