import express from "express";
import session from "express-session";
import bodyParser from "body-parser";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import fs from "fs";
import { parse } from "csv-parse";
dotenv.config();

console.log("Tutte le variabili ambiente:", process.env);


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Connessione a Supabase
const supabaseUrl = "https://laldqigtvyijitfketpv.supabase.co";
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(
  session({
    secret: "fleet_management_secret_key",
    resave: false,
    saveUninitialized: false,
  })
);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Cartelle per upload file statici
app.use(express.static(path.join(__dirname, "public")));
app.use("/assets", express.static(path.join(__dirname, "assets")));

// Configurazione di multer per il caricamento dei file
const allowedMimeTypes = [
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12",
];

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, "public", "uploads"));
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({
  storage: storage,
  fileFilter: function (req, file, cb) {
    if (file.fieldname === "importFile") {
      if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(
          new Error(
            "Tipo di file non supportato. Sono accettati solo file CSV e XLS/XLSX."
          ),
          false
        );
      }
    } else {
      // Per altri campi (es. immagini) si accetta qualsiasi tipologia di file
      cb(null, true);
    }
  },
});

// Middleware per la protezione delle rotte
const checkAuth = async (req, res, next) => {
  if (!req.session.token) return res.redirect("/login");
  const { data: user, error } = await supabase.auth.getUser(req.session.token);
  if (error || !user) return res.redirect("/login");
  req.user = user;
  next();
};

// --- ROTTE STATICHE (definite PRIMA delle dinamiche) ---

// Rotta cambio driver (rapido)
app.post('/cars/change-driver/:id', checkAuth, async (req, res) => {
  const { id } = req.params;
  const { assigned_driver, status } = req.body;

  try {
    const { error } = await supabase
      .from('cars')
      .update({ assigned_driver, status })
      .eq('id', id);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("Errore aggiornamento driver:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Rotta per la dashboard Insight
app.get("/insight", checkAuth, async (req, res) => {
  try {
    // Totale auto (usando count nella select)
    const { count: totalCount, error: totalError } = await supabase
      .from("cars")
      .select("*", { count: 'exact', head: true });
    if (totalError) throw totalError;

    // Auto assegnate
    const { count: assignedCount, error: assignedError } = await supabase
      .from("cars")
      .select("*", { count: 'exact', head: true })
      .ilike("status", "assegnata");
    if (assignedError) throw assignedError;

    // Auto disponibili (status "disponibile")
    const { count: availableCount, error: availableError } = await supabase
      .from("cars")
      .select("*", { count: 'exact', head: true })
      .ilike("status", "disponibile");
    if (availableError) throw availableError;

    // Auto in manutenzione (status "in manutenzione")
    const { count: maintenanceCount, error: maintenanceError } = await supabase
      .from("cars")
      .select("*", { count: 'exact', head: true })
      .ilike("status", "in manutenzione");
    if (maintenanceError) throw maintenanceError;

    // Totale costo mese - utilizzo di RPC per sommare i costi (supponiamo che l'RPC "sum_monthly_cost" restituisca [{ sum: ... }])
    const { data: monthlyCostData, error: monthlyCostError } = await supabase.rpc("sum_monthly_cost");
    if (monthlyCostError) throw monthlyCostError;
    const totalMonthlyCost = monthlyCostData && monthlyCostData.length > 0 ? monthlyCostData[0].sum : 0;

    // Totale costo annuo
    const { data: annualCostData, error: annualCostError } = await supabase.rpc("sum_annual_cost");
    if (annualCostError) throw annualCostError;
    const totalAnnualCost = annualCostData && annualCostData.length > 0 ? annualCostData[0].sum : 0;

    // Classifica auto per marca e modello - supponiamo un RPC "classification_by_model_brand" che restituisce array di { brand, model, count }
    const { data: classificationData, error: classificationError } = await supabase.rpc("classification_by_model_brand");
    if (classificationError) throw classificationError;

    // Km per ogni auto: selezioniamo id, brand, model e mileage
    const { data: mileageData, error: mileageError } = await supabase.from("cars").select("id, brand, model, mileage");
    if (mileageError) throw mileageError;

    res.render("insight", {
      totalCars: totalCount,
      assignedCars: assignedCount,
      availableCars: availableCount,
      maintenanceCars: maintenanceCount,
      totalMonthlyCost,
      totalAnnualCost,
      classificationData,
      mileageData,
      user: req.user
    });
  } catch (err) {
    res.send("Errore nel recuperare i dati: " + err.message);
  }
});



// Rotta per visualizzare il form per creare una nuova auto
app.get("/cars/new", checkAuth, async (req, res) => {
  // Recupera i vendors dal database, in modo che la vista (view) li possa utilizzare
  const { data: vendors, error: vendorError } = await supabase
    .from("vendors")
    .select("*");
  if (vendorError) {
    console.error("Errore nel recuperare i vendors:", vendorError);
    return res.render("new_car", { user: req.user, error: vendorError.message, vendors: [] });
  }
  res.render("new_car", { user: req.user, error: null, vendors });
});

// Rotta per visualizzare tutte le auto (lista con paginazione)
app.get("/cars/all", checkAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  const { data: cars, count, error } = await supabase
    .from("cars")
    .select("*", { count: "exact" })
    .range(offset, offset + limit - 1);
  if (error) return res.send("Errore nel recuperare le auto: " + error.message);
  const totalPages = Math.ceil(count / limit);
  res.render("all_cars", { cars, page, totalPages, user: req.user });
});

// Rotta per salvare una nuova auto
// Usa upload.fields per gestire i file (campo "images") e i campi di testo
app.post(
  "/cars/new",
  checkAuth,
  upload.fields([{ name: "images", maxCount: 10 }]),
  async (req, res) => {
    console.log("req.body:", req.body);
    
    const { brand, model, year, license_plate, fuel_type } = req.body;
    let image_urls = [];
    if (req.files && req.files.images) {
      image_urls = req.files.images.map((file) => "/uploads/" + file.filename);
    }
    const { error } = await supabase.from("cars").insert([
      {
        brand,
        model,
        year: parseInt(year),
        license_plate,
        fuel_type,
        image_url: image_urls.length > 0 ? JSON.stringify(image_urls) : null,
      },
    ]);
    if (error)
      return res.render("new_car", { user: req.user, error: error.message, vendors: [] });
    res.redirect("/dashboard");
  }
);

// Rotta per visualizzare la pagina di importazione auto massiva tramite .CSV
app.get("/cars/import", checkAuth, (req, res) => {
  res.render("import_cars", { user: req.user, error: null });
});

// Rotta per gestire l'importazione di auto da CSV
app.post(
  "/cars/import",
  checkAuth,
  upload.single("importFile"),
  async (req, res) => {
    try {
      // Verifica se il file è stato caricato
      if (!req.file) {
        console.error("❌ Nessun file ricevuto.");
        return res.render("import_cars", { user: req.user, error: "Errore: Nessun file ricevuto." });
      }

      console.log(`📂 File ricevuto: ${req.file.path}`);

      const filePath = req.file.path;
      const importedCars = [];

      // Verifica contenuto del file
      const fileContent = fs.readFileSync(filePath, "utf8");
      if (!fileContent.trim()) {
        console.error("❌ Il file è vuoto!");
        return res.render("import_cars", { user: req.user, error: "Errore: Il file è vuoto!" });
      }

      // Legge e processa il CSV
      fs.createReadStream(filePath)
        .pipe(parse({ columns: true, delimiter: ",", trim: true }))
        .on("data", (row) => {
          if (!row.brand) {
            console.warn("⚠️ Riga con brand mancante trovata:", row);
            row.brand = "Sconosciuto"; // Preveniamo l'errore di Supabase
          }

          importedCars.push({
            brand: row.brand,
            model: row.model,
            year: parseInt(row.year),
            license_plate: row.license_plate,
            fuel_type: row.fuel_type,
          });
        })
        .on("end", async () => {
          try {
            console.log(`✅ ${importedCars.length} auto pronte per l'inserimento.`);
            
            const { error } = await supabase.from("cars").insert(importedCars);
            if (error) throw error;

            fs.unlinkSync(filePath); // Cancella il file dopo l'import
            res.redirect("/dashboard");
          } catch (dbError) {
            console.error("❌ Errore in Supabase:", dbError.message);
            res.render("import_cars", { user: req.user, error: `Errore database: ${dbError.message}` });
          }
        })
        .on("error", (csvError) => {
          console.error("❌ Errore nella lettura del CSV:", csvError.message);
          res.render("import_cars", { user: req.user, error: `Errore CSV: ${csvError.message}` });
        });

    } catch (error) {
      console.error("❌ Errore generale:", error.message);
      res.render("import_cars", { user: req.user, error: "Errore interno del server." });
    }
  }
);


// Rotta per visualizzare i dettagli di una singola auto
app.get("/cars/:id", checkAuth, async (req, res) => {
  const { id } = req.params;
  const { data: car, error } = await supabase
    .from("cars")
    .select("*")
    .eq("id", id)
    .single();
  if (error)
    return res.send(
      "Errore nel recuperare i dettagli dell'auto: " + error.message
    );
  res.render("car_detail", { car, user: req.user });
});

// Rotte per la modifica (GET e POST)
app.get("/cars/edit/:id", checkAuth, async (req, res) => {
  const { id } = req.params;
  const { data: car, error } = await supabase
    .from("cars")
    .select("*")
    .eq("id", id)
    .single();
  if (error) return res.send("Errore nel recuperare l'auto: " + error.message);
  const { data: vendors, error: vendorError } = await supabase
    .from("vendors")
    .select("*");
  if (vendorError)
    return res.send("Errore nel recuperare i vendors: " + vendorError.message);
  res.render("edit_car", { car, vendors, error: null, user: req.user });
});

app.post(
  "/cars/edit/:id",
  checkAuth,
  upload.array("images", 5),
  async (req, res) => {
    const { id } = req.params;
    const {
      brand,
      model,
      year,
      license_plate,
      fuel_type,
      engine_capacity,
      horsepower,
      transmission,
      status,
      last_maintenance_date,
      mileage,
      contract_start_date,
      contract_end_date,
      monthly_cost,
      annual_cost,
      insurance_expiry_date,
      insurance_policy_number,
      inspection_date,
      color,
      assigned_driver,
      leasing_vendor_id,
      additional_notes,
    } = req.body;

    let image_urls = [];
    if (req.files && req.files.length > 0) {
      image_urls = req.files.map((file) => "/uploads/" + file.filename);
    }
    let imagesJSON = null;
    if (image_urls.length > 0) {
      imagesJSON = JSON.stringify(image_urls);
    }

    const updateData = {
      brand,
      model,
      year: parseInt(year),
      license_plate,
      fuel_type,
      engine_capacity,
      horsepower,
      transmission,
      status,
      last_maintenance_date,
      mileage: mileage ? parseInt(mileage) : null,
      contract_start_date,
      contract_end_date,
      monthly_cost: monthly_cost ? parseFloat(monthly_cost) : null,
      annual_cost: annual_cost ? parseFloat(annual_cost) : null,
      insurance_expiry_date,
      insurance_policy_number,
      inspection_date,
      color,
      assigned_driver,
      leasing_vendor_id: leasing_vendor_id || null,
      additional_notes,
    };
    if (imagesJSON) {
      updateData.image_url = imagesJSON;
    }

    const { error: updateError } = await supabase
      .from("cars")
      .update(updateData)
      .eq("id", id);
    if (updateError)
      return res.send("Errore durante l'aggiornamento: " + updateError.message);
    res.redirect("/cars/" + id);
  }
);

// Rotta per l'eliminazione di una auto
app.post("/cars/delete/:id", checkAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase.from("cars").delete().eq("id", id);
    if (error) throw error;
    res.redirect("/dashboard");
  } catch (error) {
    console.error("Errore durante l'eliminazione dell'auto:", error);
    res.status(500).send("Errore del server");
  }
});

// Rotta per il clone dell'auto
app.post("/cars/clone/:id", async (req, res) => {
  console.log(`🔄 Richiesta ricevuta per clonare l'auto con ID: ${req.params.id}`);

  try {
    const carId = req.params.id;
    const { data: existingCar, error: fetchError } = await supabase
      .from("cars")
      .select("*")
      .eq("id", carId)
      .single();

    if (fetchError || !existingCar) {
      console.error("❌ Auto non trovata o errore Supabase:", fetchError);
      return res.status(404).json({ success: false, message: "Auto non trovata" });
    }

    console.log("✅ Auto trovata nel database:", existingCar);

    const newLicensePlate = `CLONE-${Math.floor(1000 + Math.random() * 9000)}`;

    const { data: clonedCar, error: insertError } = await supabase.from("cars").insert([
      {
        brand: existingCar.brand,
        model: existingCar.model,
        year: existingCar.year,
        license_plate: newLicensePlate,
        fuel_type: existingCar.fuel_type,
        image_url: existingCar.image_url,
        assigned_driver: existingCar.assigned_driver,
        status: existingCar.status,
      },
    ]);

    if (insertError) {
      console.error("❌ Errore nell'inserimento:", insertError);
      throw insertError;
    }

    console.log("✅ Auto clonata con successo:", clonedCar);
    res.json({ success: true, clonedCar });
  } catch (error) {
    console.error("❌ Errore nella clonazione:", error);
    res.status(500).json({ success: false, message: "Errore interno del server" });
  }
});

// --- ROTTE PRINCIPALI ---

app.get("/", (req, res) => {
  if (req.session.token) return res.redirect("/dashboard");
  res.render("home", { user: null });
});
// Rotta per la registrazione utente
app.get("/signup", (req, res) => {
  res.render("signup", { error: null, user: null });
});
app.post("/signup", async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.render("signup", { error: error.message, user: null });
  res.redirect("/login");
});
// Rotta per il login dell'utente registrato
app.get("/login", (req, res) => {
  res.render("login", { error: null, user: null });
});
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) return res.render("login", { error: error.message, user: null });
  req.session.token = data.session.access_token;
  res.redirect("/dashboard");
});
// Rotta per il logout dell'utente che ha effettuato il log-in
app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

// Dashboard
app.get("/dashboard", checkAuth, async (req, res) => {
  const { data: cars, error } = await supabase.from("cars").select("*");
  if (error) return res.send("Errore nel recuperare le auto: " + error.message);
  res.render("dashboard", { cars, user: req.user });
});

// Console log per verificare che il server sia in funzione sulla porta 3000
app.listen(port, () => {
  console.log(`✅ Il server è in funzione sulla porta ${port}`);
});
