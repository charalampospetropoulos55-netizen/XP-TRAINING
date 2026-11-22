# Αντίγραφα ασφαλείας

Κάθε Δευτέρα στις 04:41 το GitHub παίρνει αντίγραφο όλης της βάσης: μέλη, συνδρομές, κρατήσεις, λογαριασμούς, κανόνες και λειτουργίες.
Το αντίγραφο κλειδώνεται με τον κωδικό `BACKUP_PASSWORD`, γιατί το repo είναι δημόσιο. Χωρίς τον κωδικό δεν ανοίγει από κανέναν.
Κάθε αντίγραφο μένει 90 μέρες, οπότε υπάρχουν πάντα περίπου 12 εβδομάδες πίσω.

## Πού τα βρίσκω

GitHub → XP-TRAINING → Actions → **Weekly backup** → διαλέγεις μια εκτέλεση → κάτω κάτω στο **Artifacts** κατεβάζεις το `xp-backup-ΗΜΕΡΟΜΗΝΙΑ`.

Για αντίγραφο τώρα: Actions → Weekly backup → **Run workflow**.

## Αν σταματήσει να δουλεύει

Το GitHub στέλνει email όταν αποτύχει μια εκτέλεση. Συνήθως φταίει ότι άλλαξε ο κωδικός της βάσης: ενημέρωσε το secret `SUPABASE_DB_URL`.

## Επαναφορά (για όποιον βοηθάει τεχνικά)

```sh
# 1. Ξεκλείδωμα
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in xp-backup-ΗΜΕΡΟΜΗΝΙΑ.tar.gz.enc -out backup.tar.gz
mkdir backup && tar xzf backup.tar.gz -C backup

# 2. Επαναφορά σε καινούριο, άδειο project Supabase (DB_URL = connection string του νέου project)
psql "$DB_URL" -f backup/roles.sql
psql "$DB_URL" -f backup/schema.sql
psql "$DB_URL" -c "SET session_replication_role = replica" -f backup/auth_data.sql -f backup/data.sql
```

Μετά άλλαξε το `supabaseUrl` και το `supabaseAnonKey` στο `config.js` με τα στοιχεία του νέου project.
Οι λειτουργίες Edge (π.χ. `account`, που στέλνει τα email με κωδικούς) δεν είναι μέσα στο αντίγραφο της βάσης και ανεβαίνουν ξανά ξεχωριστά.
