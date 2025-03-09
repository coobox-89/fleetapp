-- Abilita l'estensione per la generazione degli UUID
create extension if not exists "uuid-ossp";

-- Tabella per i fornitori (leasing vendors)
create table if not exists vendors (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  support_phone text,
  website text,
  email text,
  created_at timestamp with time zone default timezone('utc', now()),
  updated_at timestamp with time zone default timezone('utc', now())
);

-- Tabella per la baseline delle auto aziendali
create table if not exists cars (
  id uuid default uuid_generate_v4() primary key,
  brand text not null,
  model text not null,
  year integer not null,
  license_plate text not null unique,
  image_url text,
  fuel_type text,
  engine_capacity text,
  horsepower text,
  transmission text,
  status text,
  damage_sheet_url text,
  last_maintenance_date date,
  mileage integer,
  contract_start_date date,
  contract_end_date date,
  monthly_cost numeric(10,2),
  annual_cost numeric(10,2),
  insurance_expiry_date date,
  insurance_policy_number text,
  inspection_date date,
  color text,
  assigned_driver text,
  leasing_vendor_id uuid references vendors(id),
  additional_notes text,
  supabase_user_id text, -- per associare l'auto ad un utente (in futuro con AzureAD o Supabase Auth)
  created_at timestamp with time zone default timezone('utc', now()),
  updated_at timestamp with time zone default timezone('utc', now())
);
