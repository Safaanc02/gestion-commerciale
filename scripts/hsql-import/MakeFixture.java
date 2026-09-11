import java.sql.*;
/** Builds a small HSQLDB shaped like a uniCenta/Openbravo POS, to prove the reader works. */
public class MakeFixture {
  public static void main(String[] a) throws Exception {
    Class.forName("org.hsqldb.jdbc.JDBCDriver");
    try (Connection c = DriverManager.getConnection("jdbc:hsqldb:file:" + a[0] + ";shutdown=true", "SA", "")) {
      Statement s = c.createStatement();
      s.execute("CREATE TABLE CATEGORIES (ID VARCHAR(255) PRIMARY KEY, NAME VARCHAR(255))");
      s.execute("CREATE TABLE PRODUCTS (ID VARCHAR(255) PRIMARY KEY, REFERENCE VARCHAR(255), CODE VARCHAR(255), NAME VARCHAR(255), PRICEBUY DOUBLE, PRICESELL DOUBLE, CATEGORY VARCHAR(255), IMAGE VARBINARY(64))");
      s.execute("CREATE TABLE STOCKCURRENT (LOCATION VARCHAR(255), PRODUCT VARCHAR(255), UNITS DOUBLE)");
      s.execute("INSERT INTO CATEGORIES VALUES ('c1','Boissons')");
      s.execute("INSERT INTO CATEGORIES VALUES ('c2','Épicerie')");
      s.execute("INSERT INTO PRODUCTS VALUES ('p1','REF001','5449000000996','Coca Cola 33cl',5.2,8.5,'c1', X'01020304')");
      s.execute("INSERT INTO PRODUCTS VALUES ('p2','REF002','6111251420272','Eau Ain Ifrane 5L',18.0,25.0,'c1', NULL)");
      s.execute("INSERT INTO PRODUCTS VALUES ('p3','REF003','6111035001659','Thé à la menthe, 200g',9.9,14.5,'c2', NULL)");
      s.execute("INSERT INTO STOCKCURRENT VALUES ('loc1','p1',48.0)");
      s.execute("INSERT INTO STOCKCURRENT VALUES ('loc1','p2',12.5)");
    }
    System.out.println("fixture written");
  }
}
