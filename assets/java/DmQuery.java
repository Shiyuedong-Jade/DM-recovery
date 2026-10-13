import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

/**
 * 达梦只读查询桥：读一个 .sql 文件，把每条语句的结果以 JSON 输出。
 *
 * 为什么需要它：Node 侧没有达梦驱动，且本插件要求**零依赖、免构建**，
 * 所以不走 npm 的 JDBC 包装，直接用一个单文件 Java 程序做桥。
 *
 * 为什么用「SQL 文件进 / JSON 出」而不是 stdin/stdout 传协议：
 *   Windows 下 Java 的 stdin/stdout 编码容易出错，而中文库名/对象名很常见。
 *   用文件可以把编码钉死在 UTF-8，且出问题时能直接看中间产物。
 *
 * 安全：连接按只读打开；**只放行 SELECT / WITH**，其余一律拒绝并记录
 *       （这不是可选项——本插件在任何情况下都不执行变更）。
 *
 * 用法：
 *   java -cp <driver.jar> DmQuery.java <host> <port> <user> <file:password> \
 *        <sqlFile> <outJsonFile> [maxRows] [timeoutSec]
 */
public class DmQuery {

    public static void main(String[] args) throws Exception {
        PrintStream err = new PrintStream(new FileOutputStream(FileDescriptor.err), true, "UTF-8");
        if (args.length < 6) {
            err.println("用法: DmQuery <host> <port> <user> <password> <sqlFile> <outJsonFile> [maxRows] [timeoutSec]");
            System.exit(2);
        }
        String host = args[0];
        int port = Integer.parseInt(args[1]);
        String user = args[2];
        String password = args[3];
        Path sqlFile = Paths.get(args[4]);
        Path outFile = Paths.get(args[5]);
        int maxRows = args.length > 6 ? Integer.parseInt(args[6]) : 500;
        int timeoutSec = args.length > 7 ? Integer.parseInt(args[7]) : 120;

        StringBuilder json = new StringBuilder();
        json.append("{\"host\":").append(js(host)).append(",\"port\":").append(port);
        json.append(",\"statements\":[");
        boolean first = true;
        String fatal = null;
        int executed = 0;
        int rejected = 0;
        int failed = 0;

        try {
            List<String> statements = splitStatements(Files.readString(sqlFile, StandardCharsets.UTF_8));
            Class.forName("dm.jdbc.driver.DmDriver");
            DriverManager.setLoginTimeout(10);

            Properties props = new Properties();
            props.setProperty("user", user);
            props.setProperty("password", password);

            try (Connection conn = DriverManager.getConnection("jdbc:dm://" + host + ":" + port, props)) {
                try {
                    conn.setReadOnly(true);
                } catch (SQLException ignore) {
                    // 部分驱动不支持，忽略
                }

                for (String raw : statements) {
                    String sql = raw.trim();
                    if (sql.isEmpty()) continue;
                    executed++;

                    String columns = null;
                    List<String[]> rows = new ArrayList<>();
                    boolean truncated = false;
                    String error = null;

                    if (!isReadOnly(sql)) {
                        rejected++;
                        error = "REJECTED_NOT_SELECT";
                    } else {
                        try (Statement st = conn.createStatement()) {
                            st.setQueryTimeout(timeoutSec);
                            try (ResultSet rs = st.executeQuery(sql)) {
                                ResultSetMetaData md = rs.getMetaData();
                                int n = md.getColumnCount();
                                List<String> cols = new ArrayList<>();
                                for (int i = 1; i <= n; i++) cols.add(md.getColumnLabel(i));
                                columns = joinJson(cols);

                                while (rs.next()) {
                                    if (rows.size() >= maxRows) {
                                        truncated = true;
                                        break;
                                    }
                                    String[] r = new String[n];
                                    for (int i = 1; i <= n; i++) {
                                        Object v;
                                        try {
                                            v = rs.getObject(i);
                                        } catch (SQLException e) {
                                            v = "<COLUMN_READ_FAILED: " + e.getMessage() + ">";
                                        }
                                        r[i - 1] = v == null ? null : String.valueOf(v);
                                    }
                                    rows.add(r);
                                }
                            }
                        } catch (SQLException e) {
                            failed++;
                            error = e.getMessage();
                        } catch (Throwable t) {
                            failed++;
                            error = String.valueOf(t);
                        }
                    }

                    if (!first) json.append(',');
                    first = false;
                    json.append("{\"sql\":").append(js(sql));
                    json.append(",\"columns\":").append(columns == null ? "null" : columns);
                    json.append(",\"rowCount\":").append(rows.size());
                    json.append(",\"truncated\":").append(truncated);
                    json.append(",\"error\":").append(error == null ? "null" : js(error));
                    json.append(",\"rows\":[");
                    for (int i = 0; i < rows.size(); i++) {
                        if (i > 0) json.append(',');
                        json.append('[');
                        String[] r = rows.get(i);
                        for (int c = 0; c < r.length; c++) {
                            if (c > 0) json.append(',');
                            json.append(r[c] == null ? "null" : js(r[c]));
                        }
                        json.append(']');
                    }
                    json.append("]}");
                }
            }
        } catch (ClassNotFoundException e) {
            fatal = "找不到达梦 JDBC 驱动类 dm.jdbc.driver.DmDriver：请确认 -cp 指向 DmJdbcDriver8.jar";
        } catch (Throwable t) {
            fatal = String.valueOf(t);
        }

        json.append(']');
        json.append(",\"executed\":").append(executed);
        json.append(",\"rejected\":").append(rejected);
        json.append(",\"failed\":").append(failed);
        json.append(",\"fatal\":").append(fatal == null ? "null" : js(fatal));
        json.append('}');

        try {
            Files.writeString(outFile, json.toString(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            err.println("写出结果失败: " + e);
            System.exit(3);
        }
        System.exit(0);
    }

    /** 只读兜底：只放行 SELECT / WITH。BOM 与零宽字符必须先吃掉。 */
    private static boolean isReadOnly(String sql) {
        String s = sql.replace("\uFEFF", "").replace("\u200B", "").trim().toUpperCase();
        return s.startsWith("SELECT") || s.startsWith("WITH");
    }

    private static List<String> splitStatements(String text) {
        String noComments = text.replace("\uFEFF", "").replaceAll("(?m)--[^\\n\\r]*", " ");
        List<String> out = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean inStr = false;
        for (int i = 0; i < noComments.length(); i++) {
            char ch = noComments.charAt(i);
            if (ch == '\'') {
                inStr = !inStr;
                cur.append(ch);
                continue;
            }
            if (ch == ';' && !inStr) {
                out.add(cur.toString().trim());
                cur.setLength(0);
                continue;
            }
            cur.append(ch);
        }
        if (cur.toString().trim().length() > 0) out.add(cur.toString().trim());
        return out;
    }

    private static String joinJson(List<String> items) {
        StringBuilder b = new StringBuilder("[");
        for (int i = 0; i < items.size(); i++) {
            if (i > 0) b.append(',');
            b.append(js(items.get(i)));
        }
        return b.append(']').toString();
    }

    /** 最小 JSON 字符串转义。 */
    private static String js(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append('"').toString();
    }
}
