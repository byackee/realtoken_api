const { Client } = require('pg');

// Configuration API RealT
const REALT_API_URL = "https://api.realtoken.community/v1/token";
const REALT_AUTH_TOKEN = "bd627cc6-preprod-1412-a95d-af495a45d4b2"; // Remplace par ton vrai token API RealT

// Configuration PostgreSQL
const pgClient = new Client({
  host: "postgres",
  user: "nocodb",
  password: "nocodbpassword",
  database: "realtoken",
  port: 5432,
});

// Connexion à PostgreSQL
async function connectToDB() {
  try {
    await pgClient.connect();
    console.log("🟢 Connexion PostgreSQL réussie.");
    await ensureUUIDIndex();
  } catch (error) {
    console.error("❌ Erreur de connexion à PostgreSQL:", error);
  }
}

// Récupération des tokens depuis l'API RealT
async function fetchRealTokens() {
  try {
    console.log("🔄 Récupération des données depuis RealTokens...");
    const response = await fetch(REALT_API_URL, {
      method: 'GET',
      headers: {
        "X-AUTH-REALT-TOKEN": REALT_AUTH_TOKEN,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Erreur API RealTokens: ${await response.text()}`);
    }

    const tokens = await response.json();
    console.log(`✅ ${tokens.length} tokens récupérés.`);

    // Filtrer les tokens dont fullName commence par "OLD-"
    const validTokens = tokens.filter(token => !token.fullName.startsWith("OLD-"));
    
    // Découpage en lots (ici, par lots de 1000)
    const batches = batchArray(validTokens, 1000);
    
    for (const batch of batches) {
      await saveBatchToPostgres(batch);
    }

    console.log("✅ Données RealTokens insérées/mises à jour dans PostgreSQL !");
  } catch (error) {
    console.error("❌ Erreur lors de la récupération des tokens:", error);
  }
}

function toIsoTimestamp(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Fonction pour convertir les valeurs en booléen
function toBoolean(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const lowerVal = val.toLowerCase();
    return lowerVal === 'true' || lowerVal === '1' || lowerVal === 'yes';
  }
  if (typeof val === 'number') {
    return val === 1;
  }
  return false;
}

// Fonction pour convertir les valeurs en numérique
function toNumeric(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const num = parseFloat(val);
    return isNaN(num) ? null : num;
  }
  if (typeof val === 'boolean') {
    return val ? 1 : 0;
  }
  console.warn(`⚠️ Valeur non convertible en numérique: ${val} (type: ${typeof val})`);
  return null;
}

// Fonction pour découper un tableau en lots
function batchArray(array, batchSize) {
  let result = [];
  for (let i = 0; i < array.length; i += batchSize) {
    result.push(array.slice(i, i + batchSize));
  }
  return result;
}

async function getExistingUUIDs(uuids) {
  const existingRecordsMap = new Map();
  try {
    console.log("🔍 Vérification des UUID existants en base de données...");
    if (!uuids || uuids.length === 0) {
      return existingRecordsMap;
    }
    const uuidsLower = uuids.map(u => u.toLowerCase());
    const query = `
      SELECT lower(uuid) as uuid
      FROM real_tokens
      WHERE lower(uuid) = ANY($1)
      AND EXISTS (
        SELECT 1 
        FROM unnest($1) AS u(uuid) 
        WHERE lower(real_tokens.uuid) = u.uuid
      )
    `;
    const res = await pgClient.query(query, [uuidsLower]);
    for (const row of res.rows) {
      existingRecordsMap.set(row.uuid, true);
    }
    console.log(`✅ ${res.rowCount} UUIDs existants trouvés`);
  } catch (err) {
    console.error("❌ Erreur lors de la récupération des UUIDs existants:", err);
  }
  return existingRecordsMap;
}

// Création des index sur la colonne uuid si nécessaire
async function ensureUUIDIndex() {
  try {
    await pgClient.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes 
          WHERE tablename = 'real_tokens' 
          AND indexname = 'real_tokens_uuid_lower_idx'
        ) THEN
          CREATE UNIQUE INDEX real_tokens_uuid_lower_idx ON real_tokens (lower(uuid));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes 
          WHERE tablename = 'real_tokens' 
          AND indexname = 'real_tokens_uuid_lower_search_idx'
        ) THEN
          CREATE INDEX real_tokens_uuid_lower_search_idx ON real_tokens (lower(uuid));
        END IF;
      END $$;
    `);
    console.log("✅ Indexes UUID vérifiés/créés");
  } catch (error) {
    console.error("❌ Erreur lors de la création des index:", error);
  }
}

// Insère ou met à jour une batch de tokens dans PostgreSQL
async function saveBatchToPostgres(tokens) {
  try {
    const existingRecords = await getExistingUUIDs(tokens.map(t => t.uuid));
    const recordsToInsert = [];
    const recordsToUpdate = [];

    for (const token of tokens) {
      if (!token || !token.uuid) {
        console.warn("Token invalide ignoré:", token);
        continue;
      }
      const uuid = token.uuid.toLowerCase();
      const initialLaunchDate = token.initialLaunchDate ? toIsoTimestamp(token.initialLaunchDate) : null;
      const lastUpdate = token.lastUpdate ? toIsoTimestamp(token.lastUpdate) : null;
      const rentStartDate = token.rentStartDate ? toIsoTimestamp(token.rentStartDate) : null;

      // Préparation du record dans l'ordre des colonnes de la table real_tokens
      const record = [
        uuid, // uuid en minuscules
        token.fullName,
        token.shortName,
        token.symbol,
        token.productType,
        toNumeric(token.tokenPrice),
        token.canal,
        token.currency,
        toNumeric(token.totalTokens),
        toNumeric(token.totalTokensRegSummed),
        token.ethereumContract,
        token.xDaiContract || null,
        token.gnosisContract || null,
        token.goerliContract || null,
        toNumeric(token.totalInvestment),
        toNumeric(token.grossRentYear),
        toNumeric(token.grossRentMonth),
        toNumeric(token.propertyManagement),
        toNumeric(token.propertyManagementPercent),
        toNumeric(token.realtPlatform),
        toNumeric(token.realtPlatformPercent),
        toNumeric(token.insurance),
        toNumeric(token.propertyTaxes),
        toNumeric(token.utilities),
        toNumeric(token.initialMaintenanceReserve),
        toNumeric(token.netRentYear),
        toNumeric(token.netRentMonth),
        toNumeric(token.netRentDay),
        toNumeric(token.netRentDayPerToken),
        toNumeric(token.netRentMonthPerToken),
        toNumeric(token.netRentYearPerToken),
        toNumeric(token.annualPercentageYield),
        token.coordinate ? parseFloat(token.coordinate.lat) : null,
        token.coordinate ? parseFloat(token.coordinate.lng) : null,
        token.marketplaceLink,
        toNumeric(token.propertyType),
        token.propertyTypeName,
        toNumeric(token.squareFeet),
        toNumeric(token.lotSize),
        token.bedroomBath,
        toBoolean(token.hasTenants),
        toNumeric(token.rentedUnits),
        toNumeric(token.totalUnits),
        token.termOfLease || null,
        (typeof token.renewalDate === 'boolean' ? null : (token.renewalDate || null)),
        toBoolean(token.section8paid),
        token.subsidyStatus,
        token.subsidyStatusValue || null,
        token.subsidyBy || null,
        token.sellPropertyTo,
        token.secondaryMarketplace ? JSON.stringify(token.secondaryMarketplace) : null,
        token.secondaryMarketplaces ? JSON.stringify(token.secondaryMarketplaces) : null,
        token.blockchainAddresses ? JSON.stringify(token.blockchainAddresses) : null,
        toNumeric(token.underlyingAssetPrice),
        toNumeric(token.renovationReserve),
        toNumeric(token.propertyMaintenanceMonthly),
        token.seriesNumber,
        toNumeric(token.constructionYear),
        token.constructionType || null,
        token.roofType || null,
        token.assetParking || null,
        token.foundation || null,
        token.heating || null,
        token.cooling || null,
        token.tokenIdRules,
        token.rentCalculationType,
        toNumeric(token.realtListingFeePercent),
        toNumeric(token.realtListingFee),
        toNumeric(token.miscellaneousCosts),
        token.propertyStories || null,
        token.rentalType,
        token.neighborhood,
        token.originSecondaryMarketplaces ? JSON.stringify(token.originSecondaryMarketplaces) : null,
        initialLaunchDate,
        lastUpdate,
        rentStartDate,
        token.imageLink ? JSON.stringify(token.imageLink) : null
      ];

      // S'assurer qu'aucune valeur n'est undefined
      for (let i = 0; i < record.length; i++) {
        if (record[i] === undefined) {
          record[i] = null;
        }
        if (typeof record[i] === 'boolean' && i !== 40 && i !== 46) {
          console.warn(`⚠️ Valeur booléenne trouvée à l'index ${i}: ${record[i]} (type: ${typeof record[i]})`);
          if (i === 45) {
            record[i] = null;
          } else {
            record[i] = record[i] ? 1 : 0;
          }
        }
      }

      if (existingRecords.has(uuid)) {
        recordsToUpdate.push(record);
      } else {
        recordsToInsert.push(record);
      }
    }

    // Mise à jour des enregistrements existants
    if (recordsToUpdate.length > 0) {
      try {
        await pgClient.query('DROP TABLE IF EXISTS temp_real_tokens');
        await pgClient.query(`
          CREATE TABLE temp_real_tokens (
            uuid varchar(255),
            full_name varchar(255),
            short_name varchar(255),
            symbol varchar(255),
            product_type varchar(255),
            token_price decimal(10,2),
            canal varchar(255),
            currency varchar(255),
            total_tokens int,
            total_tokens_reg_summed int,
            ethereum_contract varchar(255),
            x_dai_contract varchar(255),
            gnosis_contract varchar(255),
            goerli_contract varchar(255),
            total_investment decimal(12,2),
            gross_rent_year decimal(12,2),
            gross_rent_month decimal(12,2),
            property_management decimal(10,2),
            property_management_percent decimal(5,2),
            realt_platform decimal(10,2),
            realt_platform_percent decimal(5,2),
            insurance decimal(10,2),
            property_taxes decimal(10,2),
            utilities decimal(10,2),
            initial_maintenance_reserve decimal(10,2),
            net_rent_year decimal(12,2),
            net_rent_month decimal(12,2),
            net_rent_day decimal(12,4),
            net_rent_day_per_token decimal(12,4),
            net_rent_month_per_token decimal(12,4),
            net_rent_year_per_token decimal(12,4),
            annual_percentage_yield decimal(12,4),
            latitude decimal(10,6),
            longitude decimal(10,6),
            marketplace_link varchar(255),
            property_type int,
            property_type_name varchar(255),
            square_feet int,
            lot_size int,
            bedroom_bath varchar(255),
            has_tenants boolean,
            rented_units int,
            total_units int,
            term_of_lease varchar(255),
            renewal_date varchar(255),
            section_8_paid decimal(10,2),
            subsidy_status varchar(255),
            subsidy_status_value varchar(255),
            subsidy_by varchar(255),
            sell_property_to varchar(255),
            secondary_marketplace text,
            secondary_marketplaces text,
            blockchain_addresses text,
            underlying_asset_price decimal(12,2),
            renovation_reserve decimal(10,2),
            property_maintenance_monthly decimal(10,2),
            series_number int,
            construction_year int,
            construction_type varchar(255),
            roof_type varchar(255),
            asset_parking varchar(255),
            foundation varchar(255),
            heating varchar(255),
            cooling varchar(255),
            token_id_rules int,
            rent_calculation_type varchar(255),
            realt_listing_fee_percent decimal(5,2),
            realt_listing_fee decimal(10,2),
            miscellaneous_costs decimal(10,2),
            property_stories int,
            rental_type varchar(255),
            neighborhood varchar(255),
            origin_secondary_marketplaces text,
            initial_launch_date timestamp,
            last_update timestamp,
            rent_start_date timestamp,
            image_links text
          )
        `);
        await pgClient.query(`
          CREATE INDEX temp_real_tokens_uuid_idx ON temp_real_tokens (lower(uuid))
        `);

        const insertTempQuery = `
          INSERT INTO temp_real_tokens 
          VALUES ${recordsToUpdate.map((_, i) => 
            `(${Array(77).fill().map((_, j) => `$${i * 77 + j + 1}`).join(', ')})`
          ).join(', ')}
        `;
        await pgClient.query(insertTempQuery, recordsToUpdate.flat());

        const updateQuery = `
          UPDATE real_tokens r
          SET 
            full_name = t.full_name,
            short_name = t.short_name,
            symbol = t.symbol,
            product_type = t.product_type,
            token_price = t.token_price,
            canal = t.canal,
            currency = t.currency,
            total_tokens = t.total_tokens,
            total_tokens_reg_summed = t.total_tokens_reg_summed,
            ethereum_contract = t.ethereum_contract,
            x_dai_contract = t.x_dai_contract,
            gnosis_contract = t.gnosis_contract,
            goerli_contract = t.goerli_contract,
            total_investment = t.total_investment,
            gross_rent_year = t.gross_rent_year,
            gross_rent_month = t.gross_rent_month,
            property_management = t.property_management,
            property_management_percent = t.property_management_percent,
            realt_platform = t.realt_platform,
            realt_platform_percent = t.realt_platform_percent,
            insurance = t.insurance,
            property_taxes = t.property_taxes,
            utilities = t.utilities,
            initial_maintenance_reserve = t.initial_maintenance_reserve,
            net_rent_year = t.net_rent_year,
            net_rent_month = t.net_rent_month,
            net_rent_day = t.net_rent_day,
            net_rent_day_per_token = t.net_rent_day_per_token,
            net_rent_month_per_token = t.net_rent_month_per_token,
            net_rent_year_per_token = t.net_rent_year_per_token,
            annual_percentage_yield = t.annual_percentage_yield,
            latitude = t.latitude,
            longitude = t.longitude,
            marketplace_link = t.marketplace_link,
            property_type = t.property_type,
            property_type_name = t.property_type_name,
            square_feet = t.square_feet,
            lot_size = t.lot_size,
            bedroom_bath = t.bedroom_bath,
            has_tenants = t.has_tenants,
            rented_units = t.rented_units,
            total_units = t.total_units,
            term_of_lease = t.term_of_lease,
            renewal_date = t.renewal_date,
            section_8_paid = t.section_8_paid,
            subsidy_status = t.subsidy_status,
            subsidy_status_value = t.subsidy_status_value,
            subsidy_by = t.subsidy_by,
            sell_property_to = t.sell_property_to,
            secondary_marketplace = t.secondary_marketplace,
            secondary_marketplaces = t.secondary_marketplaces,
            blockchain_addresses = t.blockchain_addresses,
            underlying_asset_price = t.underlying_asset_price,
            renovation_reserve = t.renovation_reserve,
            property_maintenance_monthly = t.property_maintenance_monthly,
            series_number = t.series_number,
            construction_year = t.construction_year,
            construction_type = t.construction_type,
            roof_type = t.roof_type,
            asset_parking = t.asset_parking,
            foundation = t.foundation,
            heating = t.heating,
            cooling = t.cooling,
            token_id_rules = t.token_id_rules,
            rent_calculation_type = t.rent_calculation_type,
            realt_listing_fee_percent = t.realt_listing_fee_percent,
            realt_listing_fee = t.realt_listing_fee,
            miscellaneous_costs = t.miscellaneous_costs,
            property_stories = t.property_stories,
            rental_type = t.rental_type,
            neighborhood = t.neighborhood,
            origin_secondary_marketplaces = t.origin_secondary_marketplaces,
            initial_launch_date = t.initial_launch_date,
            last_update = t.last_update,
            rent_start_date = t.rent_start_date,
            image_links = t.image_links
          FROM temp_real_tokens t
          WHERE lower(r.uuid) = lower(t.uuid)
        `;
        
        const result = await pgClient.query(updateQuery);
        console.log(`🔄 ${result.rowCount} enregistrements mis à jour en masse`);
        await pgClient.query('DROP TABLE IF EXISTS temp_real_tokens');
      } catch (error) {
        console.error(`❌ Erreur lors de la mise à jour en masse:`, error);
        await pgClient.query('DROP TABLE IF EXISTS temp_real_tokens');
        for (const record of recordsToUpdate) {
          try {
            const updateQuery = `
              UPDATE real_tokens
              SET 
                full_name = $2,
                short_name = $3,
                symbol = $4,
                product_type = $5,
                token_price = $6,
                canal = $7,
                currency = $8,
                total_tokens = $9,
                total_tokens_reg_summed = $10,
                ethereum_contract = $11,
                x_dai_contract = $12,
                gnosis_contract = $13,
                goerli_contract = $14,
                total_investment = $15,
                gross_rent_year = $16,
                gross_rent_month = $17,
                property_management = $18,
                property_management_percent = $19,
                realt_platform = $20,
                realt_platform_percent = $21,
                insurance = $22,
                property_taxes = $23,
                utilities = $24,
                initial_maintenance_reserve = $25,
                net_rent_year = $26,
                net_rent_month = $27,
                net_rent_day = $28,
                net_rent_day_per_token = $29,
                net_rent_month_per_token = $30,
                net_rent_year_per_token = $31,
                annual_percentage_yield = $32,
                latitude = $33,
                longitude = $34,
                marketplace_link = $35,
                property_type = $36,
                property_type_name = $37,
                square_feet = $38,
                lot_size = $39,
                bedroom_bath = $40,
                has_tenants = $41,
                rented_units = $42,
                total_units = $43,
                term_of_lease = $44,
                renewal_date = $45,
                section_8_paid = $46,
                subsidy_status = $47,
                subsidy_status_value = $48,
                subsidy_by = $49,
                sell_property_to = $50,
                secondary_marketplace = $51,
                secondary_marketplaces = $52,
                blockchain_addresses = $53,
                underlying_asset_price = $54,
                renovation_reserve = $55,
                property_maintenance_monthly = $56,
                series_number = $57,
                construction_year = $58,
                construction_type = $59,
                roof_type = $60,
                asset_parking = $61,
                foundation = $62,
                heating = $63,
                cooling = $64,
                token_id_rules = $65,
                rent_calculation_type = $66,
                realt_listing_fee_percent = $67,
                realt_listing_fee = $68,
                miscellaneous_costs = $69,
                property_stories = $70,
                rental_type = $71,
                neighborhood = $72,
                origin_secondary_marketplaces = $73,
                initial_launch_date = CAST($74 AS timestamptz),
                last_update = CAST($75 AS timestamptz),
                rent_start_date = CAST($76 AS timestamptz),
                image_links = $77
              WHERE uuid = $1
            `;
            await pgClient.query(updateQuery, record);
          } catch (singleError) {
            console.error(`❌ Erreur lors de la mise à jour de l'enregistrement ${record[0]}:`, singleError);
          }
        }
      }
    }

    // Insertion des nouveaux enregistrements
    if (recordsToInsert.length > 0) {
      const numCols = 77;
      console.log("Nombre de colonnes attendues:", numCols);
      console.log("Nombre de valeurs dans recordsToInsert[0]:", recordsToInsert[0].length);

      const placeholderArrays = recordsToInsert.map((_, i) => {
        const placeholders = [];
        for (let j = 0; j < numCols; j++) {
          if (j === 73 || j === 74 || j === 75) {
            placeholders.push(`CAST($${i * numCols + j + 1} AS timestamptz)`);
          } else {
            placeholders.push(`$${i * numCols + j + 1}`);
          }
        }
        return `(${placeholders.join(", ")})`;
      });

      const valuesPlaceholder = placeholderArrays.join(", ");
      
      const insertQuery = `
        INSERT INTO real_tokens (
          uuid, full_name, short_name, symbol, product_type, token_price, canal, currency, 
          total_tokens, total_tokens_reg_summed, ethereum_contract, x_dai_contract, gnosis_contract, 
          goerli_contract, total_investment, gross_rent_year, gross_rent_month, property_management, 
          property_management_percent, realt_platform, realt_platform_percent, insurance, property_taxes,
          utilities, initial_maintenance_reserve, net_rent_year, net_rent_month, net_rent_day, 
          net_rent_day_per_token, net_rent_month_per_token, net_rent_year_per_token, annual_percentage_yield, 
          latitude, longitude, marketplace_link, property_type, property_type_name, square_feet, lot_size,
          bedroom_bath, has_tenants, rented_units, total_units, term_of_lease, renewal_date, section_8_paid,
          subsidy_status, subsidy_status_value, subsidy_by, sell_property_to, secondary_marketplace,
          secondary_marketplaces, blockchain_addresses, underlying_asset_price, renovation_reserve,
          property_maintenance_monthly, series_number, construction_year, construction_type,
          roof_type, asset_parking, foundation, heating, cooling, token_id_rules, rent_calculation_type, 
          realt_listing_fee_percent, realt_listing_fee, miscellaneous_costs, property_stories, rental_type,
          neighborhood, origin_secondary_marketplaces, initial_launch_date, last_update,
          rent_start_date, image_links
        ) VALUES ${valuesPlaceholder}
      `;
      
      try {
        await pgClient.query(insertQuery, recordsToInsert.flat());
        console.log(`✅ ${recordsToInsert.length} enregistrements insérés`);
      } catch (error) {
        console.error(`❌ Erreur lors de l'insertion des enregistrements:`, error);
        for (const record of recordsToInsert) {
          try {
            const singleInsertQuery = `
              INSERT INTO real_tokens (
                uuid, full_name, short_name, symbol, product_type, token_price, canal, currency, 
                total_tokens, total_tokens_reg_summed, ethereum_contract, x_dai_contract, gnosis_contract, 
                goerli_contract, total_investment, gross_rent_year, gross_rent_month, property_management, 
                property_management_percent, realt_platform, realt_platform_percent, insurance, property_taxes,
                utilities, initial_maintenance_reserve, net_rent_year, net_rent_month, net_rent_day, 
                net_rent_day_per_token, net_rent_month_per_token, net_rent_year_per_token, annual_percentage_yield, 
                latitude, longitude, marketplace_link, property_type, property_type_name, square_feet, lot_size,
                bedroom_bath, has_tenants, rented_units, total_units, term_of_lease, renewal_date, section_8_paid,
                subsidy_status, subsidy_status_value, subsidy_by, sell_property_to, secondary_marketplace,
                secondary_marketplaces, blockchain_addresses, underlying_asset_price, renovation_reserve,
                property_maintenance_monthly, series_number, construction_year, construction_type,
                roof_type, asset_parking, foundation, heating, cooling, token_id_rules, rent_calculation_type, 
                realt_listing_fee_percent, realt_listing_fee, miscellaneous_costs, property_stories, rental_type,
                neighborhood, origin_secondary_marketplaces, initial_launch_date, last_update,
                rent_start_date, image_links
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                  $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40,
                  $41, $42, $43, $44, $45, $46, $47, $48, $49, $50, $51, $52, $53, $54, $55, $56, $57, $58, $59, $60,
                  $61, $62, $63, $64, $65, $66, $67, $68, $69, $70, $71, $72, $73, CAST($74 AS timestamptz),
                  CAST($75 AS timestamptz), CAST($76 AS timestamptz), $77)
            `;
            await pgClient.query(singleInsertQuery, record);
            console.log(`✅ Enregistrement inséré: ${record[0]}`);
          } catch (singleError) {
            console.error(`❌ Erreur lors de l'insertion de l'enregistrement ${record[0]}:`, singleError);
          }
        }
      }
    }
  } catch (error) {
    console.error(`❌ Erreur lors de l'enregistrement en batch :`, error);
  }
}

// Exécuter le script
(async () => {
  await connectToDB();
  await fetchRealTokens();
  await pgClient.end();
})();