import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.sql.*;
import java.util.*;

/**
 * Read a shop's existing HSQLDB and get its contents out, without touching it.
 *
 * Opened read-only and always meant to be pointed at a COPY: HSQLDB 2.x will
 * silently upgrade a database written by 1.8 the first time it opens it, and
 * that rewrite is not reversible. A till's live database is not the place to
 * discover that.
 *
 *   java -cp hsqldb.jar HsqlTool.java list   <db-base-path> [user] [password]
 *   java -cp hsqldb.jar HsqlTool.java dump   <db-base-path> <out-dir> [user] [password]
 *   java -cp hsqldb.jar HsqlTool.java query  <db-base-path> "SQL" [user] [password]
 *
 * <db-base-path> is the database file WITHOUT its extension: for a folder
 * holding unicenta.script / unicenta.data / unicenta.properties, pass
 * /path/to/unicenta.
 */
public class HsqlTool {

    /**
     * Refuse a base path that names no database.
     *
     * HSQLDB creates an empty database rather than complaining when the files
     * are not there, so a mistyped or wrongly-guessed base name reported "0
     * tables" and nothing else. Standing in a shop with one copy of the data,
     * that reads as "the database is empty" — the one conclusion that sends you
     * home with nothing. The candidates found next to the path are listed
     * because the right name is almost always one of them.
     */
    static void requireDatabaseFiles(String base) throws IOException {
        Path basePath = Paths.get(base).toAbsolutePath();
        Path dir = basePath.getParent();
        String name = basePath.getFileName().toString();
        for (String ext : new String[]{".script", ".data", ".properties"}) {
            if (Files.exists(Paths.get(base + ext))) return;
        }
        StringBuilder msg = new StringBuilder("no HSQLDB database at: " + base + "\n");
        msg.append("  (expected ").append(name).append(".script or ").append(name).append(".data next to it)\n");
        if (dir != null && Files.isDirectory(dir)) {
            TreeSet<String> found = new TreeSet<>();
            try (DirectoryStream<Path> entries = Files.newDirectoryStream(dir)) {
                for (Path p : entries) {
                    String f = p.getFileName().toString();
                    for (String ext : new String[]{".script", ".data", ".properties"}) {
                        if (f.endsWith(ext)) found.add(f.substring(0, f.length() - ext.length()));
                    }
                }
            }
            if (found.isEmpty()) {
                msg.append("  no database files at all in ").append(dir);
            } else {
                msg.append("  databases in ").append(dir).append(':');
                for (String f : found) msg.append("\n    ").append(dir.resolve(f));
            }
        }
        throw new FileNotFoundException(msg.toString());
    }

    static Connection open(String base, String user, String password) throws Exception {
        requireDatabaseFiles(base);
        Class.forName("org.hsqldb.jdbc.JDBCDriver");
        // readonly + no lock file: the shop's own system may still hold a lock,
        // and we must never write to the files we were given.
        String url = "jdbc:hsqldb:file:" + base
                + ";readonly=true;hsqldb.lock_file=false;shutdown=false";
        return DriverManager.getConnection(url, user, password);
    }

    public static void main(String[] args) throws Exception {
        try {
            run(args);
        } catch (FileNotFoundException e) {
            // An expected mistake, not a crash: print the guidance on its own.
            // A Java stack trace buries the one line that says what to fix.
            System.err.println(e.getMessage());
            System.exit(2);
        }
    }

    static void run(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: list|dump|query <db-base-path> [...]");
            System.exit(2);
        }
        String mode = args[0];
        String base = args[1];
        String user = "SA", pass = "";

        if (mode.equals("list")) {
            if (args.length >= 3) user = args[2];
            if (args.length >= 4) pass = args[3];
            try (Connection c = open(base, user, pass)) { list(c); }
        } else if (mode.equals("dump")) {
            String outDir = args[2];
            if (args.length >= 4) user = args[3];
            if (args.length >= 5) pass = args[4];
            try (Connection c = open(base, user, pass)) { dump(c, outDir); }
        } else if (mode.equals("query")) {
            String sql = args[2];
            if (args.length >= 4) user = args[3];
            if (args.length >= 5) pass = args[4];
            try (Connection c = open(base, user, pass)) { query(c, sql); }
        } else {
            System.err.println("unknown mode: " + mode);
            System.exit(2);
        }
    }

    static List<String> userTables(Connection c) throws SQLException {
        List<String> tables = new ArrayList<>();
        DatabaseMetaData md = c.getMetaData();
        try (ResultSet rs = md.getTables(null, null, "%", new String[]{"TABLE"})) {
            while (rs.next()) {
                String schema = rs.getString("TABLE_SCHEM");
                // Skip HSQLDB's own catalogues, which are always present and
                // never contain shop data.
                if (schema != null && (schema.startsWith("INFORMATION_SCHEMA") || schema.startsWith("SYSTEM_"))) continue;
                tables.add(rs.getString("TABLE_NAME"));
            }
        }
        Collections.sort(tables);
        return tables;
    }

    static void list(Connection c) throws SQLException {
        DatabaseMetaData md = c.getMetaData();
        System.out.println("database : " + md.getDatabaseProductName() + " " + md.getDatabaseProductVersion());
        System.out.println("driver   : " + md.getDriverVersion());
        System.out.println();

        List<String> tables = userTables(c);
        System.out.println(tables.size() + " tables");
        System.out.println();
        if (tables.isEmpty()) {
            // The files opened but hold nothing this account can see. Almost
            // always the wrong login rather than an empty till: HSQLDB grants
            // per-user, and the default SA sees none of another owner's tables.
            System.out.println("The database opened but shows no tables for user '"
                    + c.getMetaData().getUserName() + "'.");
            System.out.println("Try the login the shop's own software uses — look for");
            System.out.println("user/password in its .properties or .xml configuration.");
            return;
        }
        for (String t : tables) {
            long n = -1;
            try (Statement st = c.createStatement();
                 ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM \"" + t + "\"")) {
                if (rs.next()) n = rs.getLong(1);
            } catch (SQLException ignored) {
                // A table we cannot count is still worth listing.
            }
            StringBuilder cols = new StringBuilder();
            try (ResultSet rs = md.getColumns(null, null, t, "%")) {
                while (rs.next()) {
                    if (cols.length() > 0) cols.append(", ");
                    cols.append(rs.getString("COLUMN_NAME")).append(':').append(rs.getString("TYPE_NAME"));
                }
            }
            System.out.printf("%-28s %8s  %s%n", t, n < 0 ? "?" : String.valueOf(n), cols);
        }
    }

    static void dump(Connection c, String outDir) throws Exception {
        Files.createDirectories(Paths.get(outDir));
        for (String t : userTables(c)) {
            Path out = Paths.get(outDir, t + ".csv");
            try (Statement st = c.createStatement();
                 ResultSet rs = st.executeQuery("SELECT * FROM \"" + t + "\"");
                 BufferedWriter w = Files.newBufferedWriter(out, StandardCharsets.UTF_8)) {
                writeCsv(rs, w);
                System.out.println("wrote " + out);
            } catch (SQLException e) {
                System.out.println("skipped " + t + " (" + e.getMessage() + ")");
            }
        }
    }

    static void query(Connection c, String sql) throws Exception {
        try (Statement st = c.createStatement();
             ResultSet rs = st.executeQuery(sql);
             BufferedWriter w = new BufferedWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8))) {
            writeCsv(rs, w);
        }
    }

    static void writeCsv(ResultSet rs, Writer w) throws Exception {
        ResultSetMetaData m = rs.getMetaData();
        int n = m.getColumnCount();
        for (int i = 1; i <= n; i++) {
            if (i > 1) w.write(',');
            w.write(csv(m.getColumnLabel(i)));
        }
        w.write('\n');
        while (rs.next()) {
            for (int i = 1; i <= n; i++) {
                if (i > 1) w.write(',');
                Object v;
                // Binary columns (product images in a POS schema) would other-
                // wise come back as unreadable bytes and bloat the export.
                int type = m.getColumnType(i);
                if (type == Types.BINARY || type == Types.VARBINARY || type == Types.LONGVARBINARY || type == Types.BLOB) {
                    byte[] b = rs.getBytes(i);
                    v = b == null ? null : "<" + b.length + " bytes>";
                } else {
                    v = rs.getObject(i);
                }
                w.write(v == null ? "" : csv(String.valueOf(v)));
            }
            w.write('\n');
        }
        w.flush();
    }

    static String csv(String s) {
        if (s.indexOf(',') < 0 && s.indexOf('"') < 0 && s.indexOf('\n') < 0 && s.indexOf('\r') < 0) return s;
        return '"' + s.replace("\"", "\"\"").replace("\r", " ").replace("\n", " ") + '"';
    }
}
