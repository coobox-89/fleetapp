import express from "express";
import session from "express-session";
import bodyParser from "body-parser";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import fs from "fs";
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import moment from 'moment'; 
import { parse } from "csv-parse";
dotenv.config();

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
  "application/pdf"
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
    } else if (file.fieldname === "pdf" || file.fieldname === "receipt")  {
      if (file.mimetype === "application/pdf") {
        cb(null, true);
      } else {
        cb(new Error("Solo file PDF accettati per i verbali"), false);
      }
    } else {
      cb(null, true);
    }
  },
});

// Funzione per estrarre testo da un PDF
async function extractTextFromPDF(buffer) {
  const loadingTask = pdfjsLib.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;
  let fullText = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map(item => item.str);
    fullText += strings.join(' ') + '\n';
  }

  return fullText;
}

// Middleware per la protezione delle rotte
const checkAuth = async (req, res, next) => {
  if (!req.session.token) return res.redirect("/login");
  const { data: user, error } = await supabase.auth.getUser(req.session.token);
  if (error || !user) return res.redirect("/login");
  req.user = user;
  next();
};

// --- ROTTE STATICHE (definite PRIMA delle dinamiche) ---

// Correzione Rotta per upload verbale PDF
app.post('/upload-fine', upload.single('pdf'), checkAuth, async (req, res) => {
  try {
    const file = req.file;
    const plateOverrideCarId = req.body.car_id_override;

    if (!file || !file.mimetype.includes('pdf')) {
      return res.status(400).send('File non valido');
    }

    let carId = null;
    let plate = null;

    if (plateOverrideCarId) {
      const { data: carData, error: carErr } = await supabase
        .from('cars')
        .select('id, license_plate')
        .eq('id', plateOverrideCarId)
        .single();

      if (carErr || !carData) return res.status(404).send('Auto non trovata');

      carId = carData.id;
      plate = carData.license_plate;
    } else {
      const buffer = fs.readFileSync(file.path);
      const text = await extractTextFromPDF(buffer);

      const regex = /[A-Z]{2}\d{3}[A-Z]{2}/g;
      const matches = text.match(regex);

      console.log("Testo estratto dal PDF:", text);
      console.log("Targhe trovate:", matches);

      if (!matches || matches.length === 0) {
        return res.status(400).send('Targa non trovata nel PDF');
      }

      plate = matches[0];

      const { data: cars, error: carError } = await supabase
        .from('cars')
        .select('id')
        .ilike('license_plate', `%${plate}%`);

      if (carError || !cars || cars.length === 0) {
        return res.status(404).send(`Auto non trovata per la targa: ${plate}`);
      }

      carId = cars[0].id;
    }

    const fileName = `verbale_${plate}_${Date.now()}.pdf`;
    const filePath = `uploads/verbali/${fileName}`;
    const targetPath = path.join(__dirname, 'public', filePath);
    fs.renameSync(file.path, targetPath);

    const { error: insertError } = await supabase
      .from('fines')
      .insert([{
        car_id: carId,
        plate,
        file_url: `/${filePath}`,
        uploaded_at: new Date(),
        is_paid: false
      }]);

    if (insertError) {
      return res.status(500).send('Errore inserimento DB');
    }

    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).send('Errore durante l\'elaborazione del file');
  }
});

// Rotta per visualizzare i verbali associati ad una singola auto
app.get('/cars/:id/fines', checkAuth, async (req, res) => {
  const { id } = req.params;

  const { data: fines, error } = await supabase
    .from('fines')
    .select('*')
    .eq('car_id', id)
    .order('uploaded_at', { ascending: false });

  if (error) {
    return res.status(500).send('Errore nel recupero dei verbali');
  }

  res.json({ fines });
});

// Rotta per marcare un verbale come pagato e caricare la ricevuta
app.post('/mark-fine-paid/:fine_id', upload.single('receipt'), checkAuth, async (req, res) => {
  try {
    const { fine_id } = req.params;
    const file = req.file;

    if (!file || !file.mimetype.includes('pdf')) {
      return res.status(400).send('File non valido');
    }

    const fileName = `ricevuta_${fine_id}_${Date.now()}.pdf`;
    const filePath = `uploads/ricevute/${fileName}`;
    const targetPath = path.join(__dirname, 'public', filePath);
    fs.renameSync(file.path, targetPath);

    const { error } = await supabase
      .from('fines')
      .update({
        is_paid: true,
        paid_at: new Date(),
        payment_file_url: `/${filePath}`
      })
      .eq('id', fine_id);

    if (error) {
      return res.status(500).send('Errore durante aggiornamento verbale');
    }

    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).send('Errore nel caricamento della ricevuta');
  }
});



// Rotta per trigger notifiche
const checkAndNotifyExpiringContracts = async (user_id) => {
  const { data: cars, error } = await supabase
    .from('cars')
    .select('*');

  if (error) {
    console.error('Errore nel recupero auto:', error.message);
    return;
  }

  const now = new Date();
  const fourteenDaysLater = new Date();
  fourteenDaysLater.setDate(now.getDate() + 14);
  const todayISO = new Date().toISOString().split('T')[0]; // Solo la data

  for (const car of cars) {
    if (!user_id) continue;

    const scadenze = [
      {
        tipo: 'scadenza_assicurazione',
        data: car.insurance_expiry_date,
        title: 'Assicurazione in scadenza',
        message: `L'assicurazione per ${car.license_plate} scade il ${car.insurance_expiry_date}`
      },
      {
        tipo: 'scadenza_revisione',
        data: car.inspection_date,
        title: 'Revisione in scadenza',
        message: `La revisione per ${car.license_plate} scade il ${car.inspection_date}`
      },
      {
        tipo: 'scadenza_fine_contratto',
        data: car.contract_end_date,
        title: 'Fine contratto veicolo',
        message: `Il contratto del veicolo ${car.license_plate} termina il ${car.contract_end_date}`
      }
    ];

    for (const s of scadenze) {
      if (!s.data) continue;

      const dueDate = new Date(s.data);
      const daysLeft = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));

      if (daysLeft <= 14 && daysLeft >= 0) {
        // Verifica se già esiste una notifica creata oggi
        const { data: existing } = await supabase
          .from('notifications')
          .select('id')
          .eq('user_id', user_id)
          .eq('car_id', car.id)
          .eq('type', s.tipo)
          .gte('created_at', todayISO); // Solo oggi

        if (!existing || existing.length === 0) {
          const { error: insertError } = await supabase.from('notifications').insert([{
            user_id,
            car_id: car.id,
            type: s.tipo,
            title: s.title,
            message: s.message,
            is_read: false
          }]);

          if (insertError) {
            console.error(`Errore creazione notifica ${s.tipo} per ${car.license_plate}:`, insertError.message);
          }
        }
      }
    }
  }
};


// Rotta per notiiche
app.get('/notifications', checkAuth, async (req, res) => {
  const user = req.user.user; // req.user è un oggetto Supabase { user, session }
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', user.id)
    .eq('is_read', false)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    unread_count: data.length,
    notifications: data
  });
});

// Rotta per marcare una notifica come letta
app.post('/notifications/read/:id', checkAuth, async (req, res) => {
  const notificationId = req.params.id;

  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', notificationId);

  if (error) {
    return res.status(500).json({ success: false, message: error.message });
  }

  res.json({ success: true });
});

// Rotta per marcare tutte le notifiche come lette
app.post('/notifications/read-all', checkAuth, async (req, res) => {
  const user = req.user.user;

  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', user.id)
    .eq('is_read', false);

  if (error) {
    return res.status(500).json({ success: false, message: error.message });
  }

  res.json({ success: true });
});

// Rotta per visualizzare tutte le notifiche
app.get('/notifications/all', checkAuth, async (req, res) => {
  const user = req.user.user;

  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).send('Errore nel caricamento notifiche');

  res.render('notifications_all', { notifications: data });
});


// Funzione riusabile per tracciare lo storico driver
async function saveDriverHistory(carId, oldDriver, newDriver) {
  if (!oldDriver || !newDriver || oldDriver === newDriver) return;
  await supabase.from("car_driver_history").insert([
    {
      car_id: carId,
      old_driver: oldDriver,
      new_driver: newDriver,
      updated_at: new Date().toISOString(),
    },
  ]);
}

// Rotta cambio driver (rapido da dashboard)
app.post("/cars/change-driver/:id", checkAuth, async (req, res) => {
  const { id } = req.params;
  const { assigned_driver, status } = req.body;

  try {
    const { data: car, error: fetchError } = await supabase
      .from("cars")
      .select("assigned_driver")
      .eq("id", id)
      .single();

    if (fetchError || !car) throw new Error("Auto non trovata");

    await saveDriverHistory(id, car.assigned_driver, assigned_driver);

    const { error } = await supabase
      .from("cars")
      .update({ assigned_driver, status })
      .eq("id", id);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Modifica tramite edit_car
app.post("/cars/edit/:id", checkAuth, upload.array("images", 5), async (req, res) => {
  const { id } = req.params;
  const {
    brand, model, year, license_plate, fuel_type,
    engine_capacity, horsepower, transmission, status,
    last_maintenance_date, mileage, contract_start_date,
    contract_end_date, monthly_cost, annual_cost,
    insurance_expiry_date, insurance_policy_number, inspection_date,
    color, assigned_driver, leasing_vendor_id, additional_notes
  } = req.body;

  let image_urls = [];
  if (req.files && req.files.length > 0) {
    image_urls = req.files.map((file) => "/uploads/" + file.filename);
  }
  let imagesJSON = image_urls.length > 0 ? JSON.stringify(image_urls) : null;

  const { data: car, error: fetchError } = await supabase
    .from("cars")
    .select("assigned_driver")
    .eq("id", id)
    .single();

  if (fetchError) return res.send("Errore nel recuperare l'auto: " + fetchError.message);

  await saveDriverHistory(id, car.assigned_driver, assigned_driver);

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
  if (imagesJSON) updateData.image_url = imagesJSON;

  const { error: updateError } = await supabase.from("cars").update(updateData).eq("id", id);
  if (updateError) return res.send("Errore durante l'aggiornamento: " + updateError.message);
  res.redirect("/cars/" + id);
});

//Rotta per aggiornare i km
app.post('/cars/change-km/:id', checkAuth, async (req, res) => {
  const carId = req.params.id;
  const { mileage } = req.body;

  try {
    const newKm = parseInt(mileage);
    if (isNaN(newKm) || newKm < 0) {
      return res.status(400).json({ success: false, message: 'Valore chilometri non valido' });
    }

    // Ottieni i km attuali
    const { data: car, error: fetchError } = await supabase
      .from('cars')
      .select('mileage')
      .eq('id', carId)
      .single();

    if (fetchError || !car) {
      return res.status(404).json({ success: false, message: 'Auto non trovata' });
    }
    
    // Verifica se i chilometri sono effettivamente cambiati
    if (car.mileage === newKm) {
      return res.json({ success: true, message: 'Nessuna modifica necessaria' });
    }

    // Salva lo storico dei km
    await supabase.from('car_km_history').insert([{
      car_id: carId,
      old_km: car.mileage,
      new_km: newKm,
      updated_at: new Date().toISOString()
    }]);

    // Aggiorna i km nella tabella cars
    const { error: updateError } = await supabase
      .from('cars')
      .update({ mileage: newKm })
      .eq('id', carId);

    if (updateError) {
      throw updateError;
    }

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Errore interno del server' });
  }
});


// Rotta per la dashboard Insight
app.get("/insight", checkAuth, async (req, res) => {
  try {
    // Totali
    const { count: totalCount } = await supabase
      .from("cars")
      .select("*", { count: "exact", head: true });

    const { count: assignedCount } = await supabase
      .from("cars")
      .select("*", { count: "exact", head: true })
      .ilike("status", "assegnata");

    const { count: availableCount } = await supabase
      .from("cars")
      .select("*", { count: "exact", head: true })
      .ilike("status", "disponibile");

    const { count: maintenanceCount } = await supabase
      .from("cars")
      .select("*", { count: "exact", head: true })
      .ilike("status", "%manutenzione%");


    // Costi
    const { data: monthlyCostData } = await supabase.rpc("sum_monthly_cost");
    const totalMonthlyCost = monthlyCostData?.[0]?.sum || 0;

    const { data: prevMonthData } = await supabase.rpc("sum_previous_month_cost");
    const previousMonthCost = prevMonthData?.[0]?.sum || 0;

    const monthlyCostDiff = previousMonthCost > 0
      ? (((totalMonthlyCost - previousMonthCost) / previousMonthCost) * 100).toFixed(2)
      : "0.00";

    const { data: annualCostData } = await supabase.rpc("sum_annual_cost");
    const totalAnnualCost = annualCostData?.[0]?.sum || 0;

    // Classificazione auto
    const { data: classificationRaw } = await supabase.rpc("classification_by_model_brand");

const classificationData = [];

for (const item of classificationRaw) {
  const { data: matchingCars } = await supabase
    .from("cars")
    .select("image_url")
    .eq("brand", item.brand)
    .eq("model", item.model)
    .limit(1);

  classificationData.push({
    ...item,
    image_url: matchingCars?.[0]?.image_url || null
  });
}

// Conteggio veicoli elettrici e ibridi
const { data: fuelTypesCount } = await supabase
  .from("cars")
  .select("fuel_type", { count: "exact" });

let electricCount = 0;
let hybridCount = 0;
let totalFleet = fuelTypesCount.length;

fuelTypesCount.forEach(car => {
  const fuel = (car.fuel_type || "").toLowerCase();
  if (fuel === 'elettrico') electricCount++;
  else if (fuel === 'ibrido') hybridCount++;
});

// Stima impatto ambientale: ipotizziamo che ogni auto elettrica/ibrida eviti 2.1 tonnellate CO₂/anno
const estimatedCO2Saving = ((electricCount + hybridCount) * 2.1).toFixed(1);

    // Top vendors
const { data: topVendorData, error: topVendorsError } = await supabase
.from("cars")
.select("leasing_vendor_id, vendors(id, name, image_url)")
.eq("status", "Assegnata")
.limit(1000);

const vendorCountMap = {};
topVendorData.forEach(entry => {
const vendor = entry.vendors;
if (vendor) {
  const key = vendor.id;
  if (!vendorCountMap[key]) {
    vendorCountMap[key] = {
      id: vendor.id,
      name: vendor.name,
      image_url: vendor.image_url,
      count: 0,
    };
  }
  vendorCountMap[key].count += 1;
}
});

const topVendors = Object.values(vendorCountMap).sort((a, b) => b.count - a.count).slice(0, 5);


    // TASKS da fare (simulati per ora, poi li collegheremo a una tabella)
    const tasks = [
      { title: "Cambio gomme - Kia Sportage", dueDate: "2025-04-01", status: "In ritardo" },
      { title: "Tassa circolazione - GR390RY", dueDate: "2025-03-20", status: "Da fare" }
    ];

    // Scadenze veicoli (es. assicurazione, revisione) da Supabase
    const { data: deadlineData } = await supabase
      .from("cars")
      .select("brand, model, insurance_expiry_date, inspection_date");

    const upcomingDeadlines = [];

    const today = moment();

    deadlineData?.forEach(car => {
      const vehicle = `${car.brand} ${car.model}`;

      if (car.insurance_expiry_date) {
        const diff = moment(car.insurance_expiry_date).diff(today, "days");
        if (diff <= 30) {
          upcomingDeadlines.push({
            type: "Assicurazione",
            vehicle,
            date: car.insurance_expiry_date,
            critical: diff <= 7
          });
        }
      }

      if (car.inspection_date) {
        const diff = moment(car.inspection_date).diff(today, "days");
        if (diff <= 30) {
          upcomingDeadlines.push({
            type: "Revisione",
            vehicle,
            date: car.inspection_date,
            critical: diff <= 7
          });
        }
      }
    });

  //Counter verbali non pagati  
  const { data: unpaidFinesRaw, error: unpaidFinesError } = await supabase
  .from("fines")
  .select("car_id")
  .or("is_paid.eq.false,is_paid.is.false");


  const unpaidFinesCount = unpaidFinesRaw ? new Set(unpaidFinesRaw.map(f => f.car_id)).size : 0;
  const unpaidFines = unpaidFinesRaw ? unpaidFinesRaw.map(f => f.car_id) : [];

// Recupera tutte le auto (serve per il popup)
const { data: cars, error: carsError } = await supabase.from("cars").select("*");
if (carsError) throw new Error("Errore nel recupero delle auto per insight");



    res.render("insight", {
      totalCars: totalCount,
      assignedCars: assignedCount,
      availableCars: availableCount,
      maintenanceCars: maintenanceCount,
      totalMonthlyCost,
      totalAnnualCost,
      monthlyCostDiff,
      classificationData,
      tasks,
      upcomingDeadlines,
      user: req.user,
      topVendors,
      electricCount,
      hybridCount,
      estimatedCO2Saving,
      unpaidFinesCount,
      unpaidFines,
      cars,
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
        return res.render("import_cars", { user: req.user, error: "Errore: Nessun file ricevuto." });
      }

      const filePath = req.file.path;
      const importedCars = [];

      // Verifica contenuto del file
      const fileContent = fs.readFileSync(filePath, "utf8");
      if (!fileContent.trim()) {
        return res.render("import_cars", { user: req.user, error: "Errore: Il file è vuoto!" });
      }

      // Legge e processa il CSV
      fs.createReadStream(filePath)
        .pipe(parse({ columns: true, delimiter: ",", trim: true }))
        .on("data", (row) => {
          if (!row.brand) {
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
            const { error } = await supabase.from("cars").insert(importedCars);
            if (error) throw error;

            fs.unlinkSync(filePath); // Cancella il file dopo l'import
            res.redirect("/dashboard");
          } catch (dbError) {
            res.render("import_cars", { user: req.user, error: `Errore database: ${dbError.message}` });
          }
        })
        .on("error", (csvError) => {
          res.render("import_cars", { user: req.user, error: `Errore CSV: ${csvError.message}` });
        });

    } catch (error) {
      res.render("import_cars", { user: req.user, error: "Errore interno del server." });
    }
  }
);



// Rotta per visualizzare la pagina dei dettagli auto con kmHistory e driverHistory
app.get("/cars/:id", checkAuth, async (req, res) => {
  const { id } = req.params;

  const { data: car, error } = await supabase
    .from("cars")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    return res.send("Errore nel recuperare i dettagli dell'auto: " + error.message);
  }

  const { data: carFines, error: finesError } = await supabase
  .from("fines")
  .select("*")
  .eq("car_id", id)
  .order("uploaded_at", { ascending: false });

if (finesError) {
  return res.send("Errore nel recuperare i verbali: " + finesError.message);
}


  const { data: kmHistory, error: historyError } = await supabase
    .from("car_km_history")
    .select("*")
    .eq("car_id", id)
    .order("updated_at", { ascending: false });

  if (historyError) {
    return res.send("Errore nel recuperare lo storico km: " + historyError.message);
  }

  const { data: driverHistory, error: driverError } = await supabase
    .from("car_driver_history")
    .select("*")
    .eq("car_id", id)
    .order("updated_at", { ascending: false });

  if (driverError) {
    return res.send("Errore nel recuperare lo storico driver: " + driverError.message);
  }

  let vendor = null;
  if (car.leasing_vendor_id) {
    const { data: vendorData, error: vendorError } = await supabase
      .from("vendors")
      .select("*")
      .eq("id", car.leasing_vendor_id)
      .single();

    if (!vendorError && vendorData) {
      vendor = vendorData;
    }
  }


  

  res.render("car_detail", {
    car,
    user: req.user,
    kmHistory,
    driverHistory,
    vendor,
    carFines,
  });
});
// Rotta per mostrare il form di modifica con i dati precompilati
app.get("/cars/edit/:id", checkAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const { data: car, error } = await supabase
      .from("cars")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !car) {
      throw new Error("Auto non trovata o errore nel recupero");
    }

    // Recupera i vendors (opzionale, se usi un dropdown nel form)
    const { data: vendors, error: vendorError } = await supabase
      .from("vendors")
      .select("*");

    res.render("edit_car", {
      car,
      user: req.user,
      vendors: vendors || [],
      error: null,
    });
  } catch (err) {
    res.status(500).send("Errore nel caricamento del form di modifica");
  }
});



// Rotta per l'eliminazione di una auto
app.post("/cars/delete/:id", checkAuth, async (req, res) => {
  const { id } = req.params;
  try {
    // Elimina notifiche associate
    await supabase.from("notifications").delete().eq("car_id", id);

    // Elimina storico chilometri
    await supabase.from("car_km_history").delete().eq("car_id", id);

    // Elimina storico driver
    await supabase.from("car_driver_history").delete().eq("car_id", id);

    // Elimina l'auto
    const { error } = await supabase.from("cars").delete().eq("id", id);
    if (error) throw error;

    res.redirect("/dashboard");
  } catch (error) {
    console.error("Errore nella cancellazione:", error.message);
    res.status(500).send("Errore del server durante la cancellazione dell'auto");
  }
});


// Rotta per il clone dell'auto
app.post("/cars/clone/:id", async (req, res) => {
  try {
    const carId = req.params.id;
    const { data: existingCar, error: fetchError } = await supabase
      .from("cars")
      .select("*")
      .eq("id", carId)
      .single();

    if (fetchError || !existingCar) {
      return res.status(404).json({ success: false, message: "Auto non trovata" });
    }

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
      throw insertError;
    }
    res.json({ success: true, clonedCar });
  } catch (error) {
    res.status(500).json({ success: false, message: "Errore interno del server" });
  }
});

// Rotta per salvare i danni su database
app.post("/cars/save-damage/:id", checkAuth, async (req, res) => {
  const { id } = req.params;
  const { damage_markers } = req.body;

  try {
    const { error } = await supabase
      .from("cars")
      .update({ damage_markers })
      .eq("id", id);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
   // 🔔 Controlla scadenze dopo login
   const { data: user } = await supabase.auth.getUser(data.session.access_token);
   await checkAndNotifyExpiringContracts(user.user.id);
  res.redirect("/dashboard");
});
// Rotta per il logout dell'utente che ha effettuato il log-in
app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

//Dashboard
app.get("/dashboard", checkAuth, async (req, res) => {
  const { data: cars, error: carsError } = await supabase.from("cars").select("*");
  if (carsError) return res.send("Errore nel recuperare le auto: " + carsError.message);

  // Recupera gli ID delle auto con almeno un verbale non pagato
const { data: finesData, error: finesError } = await supabase
.from("fines")
.select("car_id")
.eq("is_paid", false);

const unpaidFines = finesData ? finesData.map(f => f.car_id) : [];


  // Recupero tutti i vendor
  const { data: vendors, error: vendorsError } = await supabase.from("vendors").select("*");
  if (vendorsError) return res.send("Errore nel recuperare i vendor: " + vendorsError.message);

  // Creo una mappa per trovare il vendor corrispondente a ogni car
  const vendorsMap = {};
  vendors.forEach(vendor => {
    vendorsMap[vendor.id] = vendor;
  });

  // Associo vendor a ciascuna auto
  const carsWithVendors = cars.map(car => {
    return {
      ...car,
      vendor: vendorsMap[car.leasing_vendor_id] || null
    };
  });

  res.render("dashboard", {
    cars: carsWithVendors,
    user: req.user,
    unpaidFines,
  });
});


// Console log per verificare che il server sia in funzione sulla porta 3000
app.listen(port, () => {
  console.log(`✅ Il server è in funzione sulla porta ${port}`);
});
