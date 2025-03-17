const { Pool } = require('pg');

// Configuration PostgreSQL
const pool = new Pool({
  host: 'postgres',
  database: 'realtoken',
  user: 'nocodb',
  password: 'nocodbpassword',
  port: 5432,
});

// Définition de l'URL de l'API GraphQL
const GRAPHQL_ENDPOINT = "https://gateway-arbitrum.network.thegraph.com/api/c4a3fd07adb1e3307ca045f5881cbade/subgraphs/id/FPPoFB7S2dcCNrRyjM5QbaMwKqRZPdbTg8ysBrwXd4SP";

/**
 * Récupère le userId associé à une adresse depuis TheGraph
 * @param {string} address - Adresse à interroger
 * @returns {Promise<string|null>} - Le userId ou null si non trouvé
 */
async function getUserIdFromAddress(address) {
    try {
        console.log(`🔍 Recherche du userId pour l'adresse: ${address}`);

        const query = `
            query {
                account(id: "${address.toLowerCase()}") {
                    userIds {
                        userId
                    }
                }
            }
        `;

        const response = await fetch(GRAPHQL_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query })
        });

        if (!response.ok) throw new Error(`Erreur GraphQL: ${await response.text()}`);

        const responseData = await response.json();
        if (responseData.errors) {
            console.error("❌ Erreur GraphQL détectée:", responseData.errors);
            return null;
        }

        const userId = responseData.data?.account?.userIds?.[0]?.userId || null;
        console.log(userId ? `✅ UserId trouvé: ${userId}` : "⚠️ Aucun userId trouvé pour cette adresse.");
        return userId;
    } catch (err) {
        console.error("❌ Erreur lors de la récupération du userId:", err);
        return null;
    }
}

/**
 * Récupère les comptes liés à un userId depuis TheGraph
 * @param {string} userId - L'identifiant utilisateur pour la requête
 * @returns {Promise<Array>} - Liste des adresses des comptes liés
 */
async function queryAccountsByUserId(userId) {
    try {
        console.log(`📡 Interrogation de TheGraph pour userId: ${userId}`);

        const query = `
            query ($userId: String!) { 
                accounts(where: { userIds: ["0x296033cb983747b68911244ec1a3f01d7708851b-${userId}"] }) { 
                    address 
                } 
            }
        `;

        const response = await fetch(GRAPHQL_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables: { userId } })
        });

        if (!response.ok) throw new Error(`Erreur GraphQL: ${await response.text()}`);

        const responseData = await response.json();
        if (responseData.errors) {
            console.error("❌ Erreur GraphQL détectée:", responseData.errors);
            return [];
        }

        const accounts = responseData.data?.accounts || [];
        console.log(`✅ Récupération réussie de ${accounts.length} comptes`);

        return accounts.map(acc => acc.address);
    } catch (err) {
        console.error("❌ Erreur dans la requête GraphQL:", err);
        return [];
    }
}

/**
 * Récupère les enregistrements existants de l'utilisateur dans PostgreSQL
 * @param {string} userId - L'identifiant utilisateur
 * @returns {Promise<Set>} - Ensemble des adresses déjà enregistrées
 */
async function getExistingRecordsFromPostgreSQL(userId) {
    try {
        console.log(`📂 Vérification des adresses déjà enregistrées pour userId: ${userId}...`);
        const client = await pool.connect();
        try {
            const result = await client.query(
                'SELECT address FROM user_accounts WHERE user_id = $1',
                [userId]
            );

            const existingAddresses = new Set(result.rows.map(record => record.address?.toLowerCase()));
            console.log(`✅ ${existingAddresses.size} adresses déjà présentes dans PostgreSQL.`);
            return existingAddresses;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("❌ Erreur lors de la récupération des adresses existantes:", err);
        return new Set();
    }
}

/**
 * Insère uniquement les nouvelles adresses dans PostgreSQL
 * @param {Array} addresses - Liste des adresses à enregistrer
 * @param {string} userId - L'identifiant utilisateur
 */
async function insertAddressesToPostgreSQL(addresses, userId) {
    try {
        const existingAddresses = await getExistingRecordsFromPostgreSQL(userId);

        // Filtrer uniquement les nouvelles adresses
        const newAddresses = addresses.filter(address => !existingAddresses.has(address.toLowerCase()));

        if (newAddresses.length === 0) {
            console.log("⚠️ Toutes les adresses sont déjà enregistrées dans PostgreSQL, aucune insertion requise.");
            return;
        }

        console.log(`📝 Enregistrement de ${newAddresses.length} nouvelles adresses dans PostgreSQL avec userId: ${userId}...`);

        const client = await pool.connect();
        try {
            // Création d'une table temporaire pour le batch insert
            await client.query(`
                CREATE TEMP TABLE temp_addresses (
                    address VARCHAR(255),
                    user_id VARCHAR(255)
                )
            `);

            // Insertion des données dans la table temporaire
            for (const address of newAddresses) {
                await client.query(
                    'INSERT INTO temp_addresses (address, user_id) VALUES ($1, $2)',
                    [address, userId]
                );
            }

            // Insertion des données de la table temporaire vers la table principale
            await client.query(`
                INSERT INTO user_accounts (address, user_id)
                SELECT * FROM temp_addresses
            `);

            console.log(`✅ Insertion réussie de ${newAddresses.length} nouvelles adresses dans PostgreSQL.`);
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("❌ Erreur lors de l'insertion dans PostgreSQL:", err);
    }
}

// Fonction principale
(async () => {
    try {
        const address = process.argv[2];

        if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
            console.error("❌ Adresse invalide ou non fournie. Veuillez fournir une adresse Ethereum valide.");
            process.exit(1);
        }

        const userId = await getUserIdFromAddress(address);
        if (!userId) {
            console.warn("⚠️ Aucun userId trouvé, fin du script.");
            process.exit(1);
        }

        const accounts = await queryAccountsByUserId(userId);
        if (accounts.length > 0) {
            console.log("📜 Adresses récupérées:", accounts);
            await insertAddressesToPostgreSQL(accounts, userId);
        } else {
            console.warn("⚠️ Aucune adresse trouvée pour cet utilisateur.");
        }
    } catch (err) {
        console.error("❌ Erreur dans le script principal:", err);
    } finally {
        await pool.end();
    }
})();