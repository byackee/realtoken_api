#!/bin/bash

export PGPASSWORD="nocodbpassword"

psql -U nocodb -d realtoken -c "
    DROP TABLE IF EXISTS yam_transactions_history CASCADE;

    CREATE TABLE yam_transactions_history (
        id SERIAL PRIMARY KEY,
        account_id VARCHAR(255) NOT NULL,
        transaction_id VARCHAR(255) NOT NULL,
        price DECIMAL(20,4),
        quantity DECIMAL(20,4),
        taker VARCHAR(255),
        timestamp VARCHAR(255),
        offer_id VARCHAR(255),
        offer_token_address VARCHAR(255),
        buyer_token_address VARCHAR(255),
        maker VARCHAR(255),
        UNIQUE(account_id, transaction_id)
    );

    "