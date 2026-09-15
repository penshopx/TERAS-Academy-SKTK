export type CollationFinding = {
  line: number;
  expression: string;
  reason: string;
};

export type SqlType = "text" | "uuid" | "numeric" | "timestamp" | "json" | "other";

const classifyType = (definition: string): SqlType => {
  if (/\b(?:text|varchar|character varying|char|character)\b/i.test(definition)) return "text";
  if (/\buuid\b/i.test(definition)) return "uuid";
  if (/\b(?:smallint|integer|bigint|numeric|decimal|real|double precision|serial|bigserial)\b/i.test(definition)) return "numeric";
  if (/\b(?:timestamp|date|time)\b/i.test(definition)) return "timestamp";
  if (/\bjsonb?\b/i.test(definition)) return "json";
  return "other";
};

const inferColumnTypes = (
  sql: string,
  authoritativeTypes: ReadonlyMap<string, SqlType>,
): Map<string, SqlType> => {
  const types = new Map(authoritativeTypes);
  const activeSql = splitSqlStatements(sql)
    .map((segment) => segment.text)
    .join(";\n");
  const tables =
    /\bCREATE\s+(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"?[\w$]+"?\.)?"?([\w$]+)"?\s*\(([\s\S]*?)\)\s*;/gi;
  const columnDefinition =
    /(?:^|,)\s*(?:"([^"]+)"|([a-z_][\w$]*))\s+((?:character\s+varying|double\s+precision|timestamp(?:\s+with(?:out)?\s+time\s+zone)?|[a-z]+))/gim;

  const recordType = (table: string, name: string, definition: string) => {
    const type = classifyType(definition);
    types.set(`${table.toLowerCase()}.${name.toLowerCase()}`, type);
    const previous = types.get(name.toLowerCase());
    if (!previous || previous === type) types.set(name.toLowerCase(), type);
    else types.set(name.toLowerCase(), "other");
  };

  for (const tableMatch of activeSql.matchAll(tables)) {
    const table = tableMatch[1];
    for (const columnMatch of tableMatch[2].matchAll(columnDefinition)) {
      recordType(table, columnMatch[1] ?? columnMatch[2], columnMatch[3]);
    }
  }

  const addedColumn =
    /\bALTER\s+TABLE(?:\s+IF\s+EXISTS)?\s+(?:"?[\w$]+"?\.)?"?([\w$]+)"?[^;]*?\bADD(?:\s+COLUMN)?(?:\s+IF\s+NOT\s+EXISTS)?\s+"?([\w$]+)"?\s+((?:character\s+varying|double\s+precision|timestamp(?:\s+with(?:out)?\s+time\s+zone)?|[a-z]+))/gi;
  for (const match of activeSql.matchAll(addedColumn)) {
    recordType(match[1], match[2], match[3]);
  }

  const alteredColumn =
    /\bALTER\s+TABLE(?:\s+IF\s+EXISTS)?\s+(?:"?[\w$]+"?\.)?"?([\w$]+)"?[^;]*?\bALTER\s+COLUMN\s+"?([\w$]+)"?\s+(?:SET\s+DATA\s+)?TYPE\s+((?:character\s+varying|double\s+precision|timestamp(?:\s+with(?:out)?\s+time\s+zone)?|[a-z]+))/gi;
  for (const match of activeSql.matchAll(alteredColumn)) {
    recordType(match[1], match[2], match[3]);
  }

  const alterTableStatement =
    /\bALTER\s+TABLE(?:\s+IF\s+EXISTS)?\s+(?:"?[\w$]+"?\.)?"?([\w$]+)"?\s+([\s\S]*?);/gi;
  for (const statement of activeSql.matchAll(alterTableStatement)) {
    const table = statement[1];
    for (const action of statement[2].matchAll(
      /\bADD(?:\s+COLUMN)?(?:\s+IF\s+NOT\s+EXISTS)?\s+"?([\w$]+)"?\s+((?:character\s+varying|double\s+precision|timestamp(?:\s+with(?:out)?\s+time\s+zone)?|[a-z]+))/gi,
    )) {
      recordType(table, action[1], action[2]);
    }
    for (const action of statement[2].matchAll(
      /\bALTER\s+COLUMN\s+"?([\w$]+)"?\s+(?:SET\s+DATA\s+)?TYPE\s+((?:character\s+varying|double\s+precision|timestamp(?:\s+with(?:out)?\s+time\s+zone)?|[a-z]+))/gi,
    )) {
      recordType(table, action[1], action[2]);
    }
  }

  const createTableAs =
    /\bCREATE\s+(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+"?([\w$]+)"?\s+AS\s+SELECT\s+(?:(?:"?([\w$]+)"?)\.)?"?([\w$]+)"?(?:\s+AS\s+"?([\w$]+)"?)?\s+FROM\s+"?([\w$]+)"?/gi;
  for (const match of activeSql.matchAll(createTableAs)) {
    const sourceTable = (match[2] ?? match[5]).toLowerCase();
    const sourceColumn = match[3].toLowerCase();
    const outputColumn = (match[4] ?? match[3]).toLowerCase();
    const type = types.get(`${sourceTable}.${sourceColumn}`);
    if (type) {
      types.set(`${match[1].toLowerCase()}.${outputColumn}`, type);
    }
  }

  return types;
};

const lineAt = (sql: string, index: number): number =>
  sql.slice(0, index).split("\n").length;

type SqlSegment = { text: string; index: number };

const splitSqlStatements = (sql: string, baseIndex = 0): SqlSegment[] => {
  const segments: SqlSegment[] = [];
  let statementStart = 0;
  let sanitized = "";

  const pushStatement = (end: number) => {
    const text = sanitized.slice(statementStart, end);
    if (text.trim()) segments.push({ text, index: baseIndex + statementStart });
    statementStart = end + 1;
  };

  for (let index = 0; index < sql.length;) {
    if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index + 2);
      const stop = end === -1 ? sql.length : end;
      sanitized += sql.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      sanitized += sql.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
      continue;
    }
    if (sql[index] === "'") {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === "'" && sql[end + 1] === "'") {
          end += 2;
          continue;
        }
        if (sql[end] === "'") {
          end += 1;
          break;
        }
        end += 1;
      }
      const masked = [...sql.slice(index, end).replace(/[^\n]/g, " ")];
      masked[0] = "'";
      if (masked.length > 1) masked[masked.length - 1] = "'";
      sanitized += masked.join("");
      index = end;
      continue;
    }
    if (sql[index] === "$") {
      const tag = sql.slice(index).match(/^\$[a-z_][\w$]*\$|^\$\$/i)?.[0];
      if (tag) {
        const bodyStart = index + tag.length;
        const close = sql.indexOf(tag, bodyStart);
        if (close !== -1) {
          const statementPrefix = sanitized.slice(statementStart, index);
          if (
            /\b(?:DO|CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE))\b/i.test(
              statementPrefix,
            )
          ) {
            segments.push(
              ...splitSqlStatements(
                sql.slice(bodyStart, close),
                baseIndex + bodyStart,
              ),
            );
          }
          const end = close + tag.length;
          sanitized += sql.slice(index, end).replace(/[^\n]/g, " ");
          index = end;
          continue;
        }
      }
    }
    if (sql[index] === ";") {
      pushStatement(index);
      sanitized += ";";
      index += 1;
      continue;
    }
    sanitized += sql[index];
    index += 1;
  }

  const text = sanitized.slice(statementStart);
  if (text.trim()) segments.push({ text, index: baseIndex + statementStart });
  return segments;
};

const normalizedColumnName = (
  expression: string,
): { qualifier?: string; column: string } | undefined => {
  const withoutDirection = expression
    .replace(/\s+(?:ASC|DESC)(?:\s+NULLS\s+(?:FIRST|LAST))?\s*$/i, "")
    .trim();
  const match = withoutDirection.match(
    /^(?:(?:"?([\w$]+)"?)\.)?"?([\w$]+)"?$/,
  );
  if (!match) return undefined;
  return {
    qualifier: match[1]?.toLowerCase(),
    column: match[2].toLowerCase(),
  };
};

const splitTopLevelExpressions = (list: string): string[] => {
  const expressions: string[] = [];
  let start = 0;
  let depth = 0;
  let quotedIdentifier = false;
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] === '"') quotedIdentifier = !quotedIdentifier;
    if (quotedIdentifier) continue;
    if (list[index] === "(") depth += 1;
    else if (list[index] === ")") depth -= 1;
    else if (list[index] === "," && depth === 0) {
      expressions.push(list.slice(start, index));
      start = index + 1;
    }
  }
  expressions.push(list.slice(start));
  return expressions;
};

const matchingParenthesis = (text: string, openingIndex: number): number => {
  let depth = 0;
  let quotedIdentifier = false;
  for (let index = openingIndex; index < text.length; index += 1) {
    if (text[index] === '"') quotedIdentifier = !quotedIdentifier;
    if (quotedIdentifier) continue;
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const isUnsafeTextExpression = (
  expression: string,
  columnTypes: Map<string, SqlType>,
  aliases: Map<string, string>,
  defaultTable?: string,
  candidateTables: ReadonlySet<string> = new Set(),
): boolean => {
  let normalized = expression
    .replace(
      /\s+(?:(?:ASC|DESC)(?:\s+NULLS\s+(?:FIRST|LAST))?|NULLS\s+(?:FIRST|LAST)|USING\s+[\s\S]+?)\s*$/i,
      "",
    )
    .trim();
  while (
    normalized.startsWith("(") &&
    matchingParenthesis(normalized, 0) === normalized.length - 1
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  const collations = [
    ...normalized.matchAll(/\bCOLLATE\s+(?:"([^"]+)"|([\w.]+))/gi),
  ].filter((match) => {
    let depth = 0;
    for (let index = 0; index < match.index; index += 1) {
      if (normalized[index] === "(") depth += 1;
      else if (normalized[index] === ")") depth -= 1;
    }
    return (
      depth === 0 &&
      normalized.slice(match.index + match[0].length).trim().length === 0
    );
  });
  if (
    collations.some(
      (match) => (match[1] ?? match[2]).toUpperCase() === "C",
    )
  ) return false;
  for (const match of collations.reverse()) {
    normalized =
      normalized.slice(0, match.index) +
      normalized.slice(match.index + match[0].length);
  }
  normalized = normalized.trim();
  if (/^(?:E|U&)?'(?:[^']|'')*'$/i.test(normalized)) return true;
  if (/(?:->>|#>>)/.test(normalized)) return true;
  const arrayConstructor = normalized.match(/^ARRAY\s*\[([\s\S]*)\]$/i);
  if (arrayConstructor) {
    return splitTopLevelExpressions(arrayConstructor[1]).some((item) =>
      isUnsafeTextExpression(
        item,
        columnTypes,
        aliases,
        defaultTable,
        candidateTables,
      )
    );
  }
  const rowItems = splitTopLevelExpressions(normalized);
  if (rowItems.length > 1) {
    return rowItems.some((item) =>
      isUnsafeTextExpression(
        item,
        columnTypes,
        aliases,
        defaultTable,
        candidateTables,
      )
    );
  }
  if (/::\s*(?:text|varchar|character varying|char|character)\b/i.test(normalized)) {
    return true;
  }
  if (
    /^CAST\s*\([\s\S]+\s+AS\s+(?:text|varchar|character\s+varying|char|character)(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?\s*\)$/i.test(
      normalized,
    )
  ) {
    return true;
  }
  const textFunction = normalized.match(
    /^(lower|upper|btrim|ltrim|rtrim|trim|substring|substr|left|right|replace|regexp_replace|translate|initcap|reverse|repeat|lpad|rpad)\s*\(([\s\S]+)\)$/i,
  );
  if (textFunction) {
    let operand = textFunction[2];
    if (/^(?:substring|substr)$/i.test(textFunction[1])) {
      operand = operand.replace(/\bFROM\b[\s\S]*$/i, "");
    } else if (/^trim$/i.test(textFunction[1]) && /\bFROM\b/i.test(operand)) {
      operand = operand.replace(/^[\s\S]*\bFROM\b/i, "");
    }
    return isUnsafeTextExpression(
      operand,
      columnTypes,
      aliases,
      defaultTable,
      candidateTables,
    );
  }
  if (/^SELECT\b/i.test(normalized)) {
    let depth = 0;
    let fromIndex = -1;
    for (const from of normalized.matchAll(/\bFROM\b/gi)) {
      for (let index = 0; index < from.index; index += 1) {
        if (normalized[index] === "(") depth += 1;
        else if (normalized[index] === ")") depth -= 1;
      }
      if (depth === 0) {
        fromIndex = from.index;
        break;
      }
      depth = 0;
    }
    const projection = normalized
      .slice("SELECT".length, fromIndex === -1 ? undefined : fromIndex)
      .trim();
    if (projection) {
      return isUnsafeTextExpression(
        projection,
        columnTypes,
        aliases,
        defaultTable,
        candidateTables,
      );
    }
  }
  const coalesce = normalized.match(/^coalesce\s*\(([\s\S]+)\)$/i);
  if (coalesce) {
    return coalesce[1]
      .split(",")
      .some((argument) =>
        isUnsafeTextExpression(
          argument,
          columnTypes,
          aliases,
          defaultTable,
          candidateTables,
        )
      );
  }
  const concat = normalized.match(/^concat(?:_ws)?\s*\(([\s\S]+)\)$/i);
  if (concat) return true;
  if (normalized.includes("||")) return true;
  if (/^CASE\b[\s\S]*\bEND$/i.test(normalized)) {
    const branches = [
      ...normalized.matchAll(/\bTHEN\s+([\s\S]*?)(?=\bWHEN\b|\bELSE\b|\bEND\b)/gi),
      ...normalized.matchAll(/\bELSE\s+([\s\S]*?)(?=\bEND\b)/gi),
    ];
    return branches.some((branch) =>
      isUnsafeTextExpression(
        branch[1],
        columnTypes,
        aliases,
        defaultTable,
        candidateTables,
      )
    );
  }
  const genericFunction = normalized.match(/^([a-z_][\w$]*)\s*\(([\s\S]*)\)$/i);
  if (genericFunction) {
    const nonTextFunctions = new Set([
      "count", "length", "char_length", "character_length", "octet_length",
      "bit_length", "position", "strpos", "ascii", "extract", "date_part",
      "cardinality", "array_length", "json_array_length", "jsonb_array_length",
    ]);
    if (nonTextFunctions.has(genericFunction[1].toLowerCase())) return false;
    if (/^jsonb?_/.test(genericFunction[1].toLowerCase())) return false;
    return splitTopLevelExpressions(genericFunction[2]).some((argument) =>
      isUnsafeTextExpression(
        argument.replace(/\bFROM\b[\s\S]*$/i, ""),
        columnTypes,
        aliases,
        defaultTable,
        candidateTables,
      )
    );
  }
  const column = normalizedColumnName(normalized);
  if (!column) return false;
  const table = column.qualifier
    ? (aliases.get(column.qualifier) ?? column.qualifier)
    : defaultTable;
  let type = table
    ? columnTypes.get(`${table}.${column.column}`)
    : columnTypes.get(column.column);
  if (!type && table) type = columnTypes.get(column.column);
  if (!type || type === "other") {
    const candidateTypes = [...candidateTables]
      .map((candidate) => columnTypes.get(`${candidate}.${column.column}`))
      .filter((candidate): candidate is SqlType => candidate !== undefined);
    const concreteTypes = new Set(candidateTypes.filter((candidate) => candidate !== "other"));
    if (concreteTypes.size === 1) type = [...concreteTypes][0];
  }
  return type === "text";
};

export const findUnsafeTextWinnerOrdering = (
  sql: string,
  schemaContext = sql,
  authoritativeTypes: ReadonlyMap<string, SqlType> = new Map(),
): CollationFinding[] => {
  const columnTypes = inferColumnTypes(schemaContext, authoritativeTypes);
  const sqlKeywords = new Set([
    "where", "set", "on", "order", "limit", "group", "returning", "values",
  ]);
  const findings: CollationFinding[] = [];

  for (const segment of splitSqlStatements(sql)) {
    const tableReference =
      /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:"?[\w$]+"?\.)?"?([\w$]+)"?(?:\s+(?:AS\s+)?([a-z_][\w$]*))?/gi;
    const depthAt = (end: number): number => {
      let depth = 0;
      for (let index = 0; index < end; index += 1) {
        if (segment.text[index] === "(") depth += 1;
        else if (segment.text[index] === ")") depth -= 1;
      }
      return depth;
    };
    const virtualTypes = new Map<string, SqlType>();
    const scopeBoundsAt = (index: number): [number, number] => {
      if (depthAt(index) === 0) return [0, segment.text.length];
      let nesting = 0;
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        if (segment.text[cursor] === ")") nesting += 1;
        else if (segment.text[cursor] === "(") {
          if (nesting === 0) {
            const end = matchingParenthesis(segment.text, cursor);
            return [cursor + 1, end === -1 ? segment.text.length : end];
          }
          nesting -= 1;
        }
      }
      return [0, segment.text.length];
    };
    const environmentAt = (index: number) => {
      const [scopeStart, scopeEnd] = scopeBoundsAt(index);
      const depth = depthAt(index);
      const aliases = new Map<string, string>();
      const tables = new Set<string>();
      for (const match of segment.text.matchAll(tableReference)) {
        if (
          match.index < scopeStart ||
          match.index >= scopeEnd ||
          depthAt(match.index) !== depth
        ) continue;
        const table = match[1].toLowerCase();
        tables.add(table);
        aliases.set(table, table);
        const alias = match[2]?.toLowerCase();
        if (alias && !sqlKeywords.has(alias)) aliases.set(alias, table);
      }
      const defaultTable = tables.size === 1 ? [...tables][0] : undefined;
      const scopedTypes = new Map([...columnTypes, ...virtualTypes]);
      for (const projection of projectionItemsAt(index)) {
        if (!projection.alias) continue;
        if (
          isUnsafeTextExpression(
            projection.source,
            scopedTypes,
            aliases,
            defaultTable,
            tables,
          )
        ) {
          scopedTypes.set(projection.alias, "text");
        }
      }
      return { aliases, tables, defaultTable, scopedTypes };
    };
    const projectionItemsAt = (
      orderIndex: number,
    ): Array<{ source: string; alias?: string }> => {
      const orderDepth = depthAt(orderIndex);
      let selectEnd = -1;
      for (const select of segment.text.matchAll(/\bSELECT\b/gi)) {
        if (select.index >= orderIndex) break;
        if (depthAt(select.index) === orderDepth) {
          selectEnd = select.index + select[0].length;
        }
      }
      if (selectEnd === -1) return [];
      let fromIndex = -1;
      for (const from of segment.text.slice(selectEnd, orderIndex).matchAll(/\bFROM\b/gi)) {
        const absoluteIndex = selectEnd + from.index;
        if (depthAt(absoluteIndex) === orderDepth) {
          fromIndex = absoluteIndex;
          break;
        }
      }
      const listEnd = fromIndex === -1 ? orderIndex : fromIndex;
      let list = segment.text.slice(selectEnd, listEnd).trim();
      const distinct = list.match(/^DISTINCT\s+ON\s*\(/i);
      if (distinct) {
        const opening = list.indexOf("(", distinct.index);
        const closing = matchingParenthesis(list, opening);
        if (closing !== -1) list = list.slice(closing + 1).trim();
      }
      list = list.replace(/^DISTINCT\s+/i, "");
      return splitTopLevelExpressions(list).map((projection) => {
        const trimmed = projection.trim();
        const explicit = trimmed.match(
          /^([\s\S]+)\s+AS\s+"?([a-z_][\w$]*)"?$/i,
        );
        if (explicit) {
          return {
            source: explicit[1].trim(),
            alias: explicit[2].toLowerCase(),
          };
        }
        if (!/\bCOLLATE\s+(?:"[^"]+"|[\w.]+)\s*$/i.test(trimmed)) {
          const implicit = trimmed.match(
            /^([\s\S]+?)\s+(?:"([^"]+)"|([a-z_][\w$]*))$/i,
          );
          if (implicit) {
            return {
              source: implicit[1].trim(),
              alias: (implicit[2] ?? implicit[3]).toLowerCase(),
            };
          }
        }
        return { source: trimmed };
      });
    };
    const projectedExpressionsAt = (orderIndex: number): string[] =>
      projectionItemsAt(orderIndex).map((projection) => projection.source);

    const recordVirtualType = (
      relation: string,
      column: string,
      type: SqlType,
    ) => {
      virtualTypes.set(`${relation.toLowerCase()}.${column}`, type);
      const previous = virtualTypes.get(column);
      if (!previous || previous === type) virtualTypes.set(column, type);
      else virtualTypes.set(column, "other");
    };

    const registerVirtualRelation = (
      name: string,
      bodyEnd: number,
      explicitColumns?: string[],
    ) => {
      const scopeIndex = bodyEnd - 1;
      const [scopeStart] = scopeBoundsAt(scopeIndex);
      const depth = depthAt(scopeIndex);
      const setOperations = [
        ...segment.text.matchAll(/\b(?:UNION(?:\s+ALL)?|INTERSECT|EXCEPT)\b/gi),
      ].filter(
        (operation) =>
          operation.index >= scopeStart &&
          operation.index < bodyEnd &&
          depthAt(operation.index) === depth,
      );
      const branchEnds = [...setOperations.map((operation) => operation.index), bodyEnd];
      const branches = branchEnds
        .map((branchEnd) => projectionItemsAt(branchEnd - 1))
        .filter((branch) => branch.length > 0);
      const firstBranch = branches[0] ?? [];
      const environment = environmentAt(scopeIndex);
      const resolveProjectionType = (source: string): SqlType => {
        if (
          isUnsafeTextExpression(
            source,
            environment.scopedTypes,
            environment.aliases,
            environment.defaultTable,
            environment.tables,
          )
        ) return "text";
        const normalized = source.trim();
        if (/^(?:NULL|TRUE|FALSE)$/i.test(normalized)) return "other";
        if (/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) return "numeric";
        const column = normalizedColumnName(normalized);
        if (!column) return "other";
        const table = column.qualifier
          ? (environment.aliases.get(column.qualifier) ?? column.qualifier)
          : environment.defaultTable;
        const direct = table
          ? environment.scopedTypes.get(`${table}.${column.column}`)
          : environment.scopedTypes.get(column.column);
        if (direct) return direct;
        const candidateTypes = [...environment.tables]
          .map((candidate) =>
            environment.scopedTypes.get(`${candidate}.${column.column}`)
          )
          .filter((type): type is SqlType => type !== undefined);
        const concrete = new Set(candidateTypes.filter((type) => type !== "other"));
        return concrete.size === 1 ? [...concrete][0] : "other";
      };

      firstBranch.forEach((projection, position) => {
        const outputName =
          explicitColumns?.[position] ??
          projection.alias ??
          normalizedColumnName(projection.source)?.column;
        if (!outputName) return;
        const branchTypes = branches.map((branch) =>
          branch[position] ? resolveProjectionType(branch[position].source) : "other"
        );
        const type = branchTypes.includes("text")
          ? "text"
          : (branchTypes.find((branchType) => branchType !== "other") ?? "other");
        recordVirtualType(name, outputName, type);
      });
    };

    const cte =
      /(?:\bWITH(?:\s+RECURSIVE)?\b|,)\s*"?([\w$]+)"?(?:\s*\(([^)]*)\))?\s+AS\s+(?:(?:NOT\s+)?MATERIALIZED\s+)?\(/gi;
    for (const match of segment.text.matchAll(cte)) {
      const openingIndex = match.index + match[0].lastIndexOf("(");
      const closingIndex = matchingParenthesis(segment.text, openingIndex);
      if (closingIndex === -1) continue;
      const explicitColumns = match[2]
        ?.split(",")
        .map((column) => column.trim().replace(/^"|"$/g, "").toLowerCase());
      registerVirtualRelation(match[1], closingIndex, explicitColumns);
    }

    const derivedTable = /\bFROM\s*\(/gi;
    for (const match of segment.text.matchAll(derivedTable)) {
      const openingIndex = match.index + match[0].lastIndexOf("(");
      const closingIndex = matchingParenthesis(segment.text, openingIndex);
      if (closingIndex === -1) continue;
      const alias = segment.text
        .slice(closingIndex + 1)
        .match(/^\s*(?:AS\s+)?"?([\w$]+)"?/i)?.[1];
      if (!alias) continue;
      const columns = segment.text
        .slice(closingIndex + 1)
        .match(
          /^\s*(?:AS\s+)?"?[\w$]+"?\s*\(([^)]*)\)/i,
        )?.[1]
        ?.split(",")
        .map((column) => column.trim().replace(/^"|"$/g, "").toLowerCase());
      const body = segment.text.slice(openingIndex + 1, closingIndex).trim();
      if (/^VALUES\b/i.test(body) && columns) {
        const environment = environmentAt(match.index);
        const row = body.match(/^VALUES\s*\(([\s\S]*?)\)/i)?.[1];
        if (row) {
          splitTopLevelExpressions(row).forEach((value, position) => {
            const column = columns[position];
            if (!column) return;
            const type = isUnsafeTextExpression(
              value,
              environment.scopedTypes,
              environment.aliases,
              environment.defaultTable,
              environment.tables,
            )
              ? "text"
              : /^[+-]?\d+(?:\.\d+)?$/.test(value.trim())
                ? "numeric"
                : "other";
            recordVirtualType(alias, column, type);
          });
        }
      } else {
        registerVirtualRelation(alias, closingIndex, columns);
      }
    }

    const addOrderFindings = (
      orderList: string,
      index: number,
      resolvePosition = false,
    ) => {
      const projections = resolvePosition ? projectedExpressionsAt(index) : [];
      const { aliases, tables, defaultTable, scopedTypes } =
        environmentAt(index);
      for (const expression of splitTopLevelExpressions(orderList)) {
        const position = expression
          .trim()
          .match(
            /^(\d+)(?:\s+(?:ASC|DESC))?(?:\s+NULLS\s+(?:FIRST|LAST))?$/i,
          );
        const resolvedExpression = position
          ? (projections[Number(position[1]) - 1] ?? expression)
          : expression;
        if (
          !isUnsafeTextExpression(
            resolvedExpression,
            scopedTypes,
            aliases,
            defaultTable,
            tables,
          )
        ) continue;
        findings.push({
          line: lineAt(sql, segment.index + index),
          expression: expression.trim(),
          reason: "winner ORDER BY uses a text expression without explicit COLLATE",
        });
      }
    };

    const scopeEndAt = (start: number, depth: number): number => {
      for (let index = start; index < segment.text.length; index += 1) {
        if (segment.text[index] === ")" && depthAt(index + 1) < depth) return index;
      }
      return segment.text.length;
    };
    const orderClauses = [...segment.text.matchAll(/\bORDER\s+BY\b/gi)];
    const limitClauses = [...segment.text.matchAll(/\bLIMIT\b/gi)];
    const fetchClauses = [
      ...segment.text.matchAll(/\bFETCH\s+(?:FIRST|NEXT)\b/gi),
    ];
    const offsetClauses = [...segment.text.matchAll(/\bOFFSET\b/gi)];

    for (const order of orderClauses) {
      const depth = depthAt(order.index);
      const scopeEnd = scopeEndAt(order.index, depth);
      const limit = limitClauses.find(
        (clause) =>
          clause.index > order.index &&
          clause.index < scopeEnd &&
          depthAt(clause.index) === depth,
      );
      const fetch = fetchClauses.find(
        (clause) =>
          clause.index > order.index &&
          clause.index < scopeEnd &&
          depthAt(clause.index) === depth,
      );
      const winnerClauses: RegExpExecArray[] = [];
      if (limit) winnerClauses.push(limit);
      if (fetch) winnerClauses.push(fetch);
      const winner = winnerClauses.sort(
        (left, right) => left.index - right.index,
      )[0];
      if (!winner) continue;

      let winnerIsSingleRow = true;
      if (winner[0].toUpperCase() === "LIMIT") {
        const limitEnd = offsetClauses.find(
          (clause) =>
            clause.index > winner.index &&
            clause.index < scopeEnd &&
            depthAt(clause.index) === depth,
        )?.index ?? scopeEnd;
        let value = segment.text
          .slice(winner.index + winner[0].length, limitEnd)
          .trim()
          .replace(/[);]+$/g, "")
          .trim();
        while (
          value.startsWith("(") &&
          matchingParenthesis(value, 0) === value.length - 1
        ) {
          value = value.slice(1, -1).trim();
        }
        const numeric = value.match(/^0*(\d+)(?:\s*::\s*[\w.]+)?$/);
        winnerIsSingleRow =
          !/^ALL$/i.test(value) && (!numeric || Number(numeric[1]) === 1);
      } else {
        const fetchText = segment.text.slice(winner.index, scopeEnd);
        const count = fetchText.match(
          /^\bFETCH\s+(?:FIRST|NEXT)\s+(?:(\d+)\s+)?ROWS?\s+ONLY/i,
        )?.[1];
        winnerIsSingleRow = count === undefined || Number(count) === 1;
      }
      if (!winnerIsSingleRow) continue;

      const offset = offsetClauses.find(
        (clause) =>
          clause.index > order.index &&
          clause.index < winner.index &&
          depthAt(clause.index) === depth,
      );
      const orderEnd = offset?.index ?? winner.index;
      addOrderFindings(
        segment.text.slice(order.index + order[0].length, orderEnd),
        order.index,
        true,
      );
    }

    const addNamedWindowFindings = (
      windowName: string,
      index: number,
      visited = new Set<string>(),
    ) => {
      const normalizedName = windowName.toLowerCase();
      if (visited.has(normalizedName)) return;
      visited.add(normalizedName);
      const name = windowName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const definitionPattern = new RegExp(
        `(?:\\bWINDOW\\b|,)\\s*"?${name}"?\\s+AS\\s*\\(`,
        "gi",
      );
      const definition = [...segment.text.matchAll(definitionPattern)].find(
        (candidate) =>
          candidate.index > index &&
          depthAt(candidate.index) === depthAt(index),
      );
      if (!definition) return;
      const openingIndex =
        definition.index + definition[0].lastIndexOf("(");
      const closingIndex = matchingParenthesis(segment.text, openingIndex);
      if (closingIndex === -1) return;
      const windowBody = segment.text.slice(openingIndex + 1, closingIndex);
      const order = windowBody.match(
        /\bORDER\s+BY\s+([\s\S]*?)(?:\bROWS\b|\bRANGE\b|\bGROUPS\b|$)/i,
      );
      if (order) addOrderFindings(order[1], definition.index);
      else {
        const inherited = windowBody
          .trim()
          .match(/^(?:"([^"]+)"|([\w$]+))/);
        if (inherited) {
          addNamedWindowFindings(inherited[1] ?? inherited[2], index, visited);
        }
      }
    };

    const winnerWindowFunction =
      /\b(?:row_number|rank|dense_rank|first_value|last_value|nth_value)\s*\(/gi;
    for (const match of segment.text.matchAll(winnerWindowFunction)) {
      const functionOpening = match.index + match[0].lastIndexOf("(");
      const functionClosing =
        matchingParenthesis(segment.text, functionOpening);
      if (functionClosing === -1) continue;
      const over = segment.text
        .slice(functionClosing + 1)
        .match(/^\s*OVER\s*/i);
      if (!over) continue;
      const specificationStart = functionClosing + 1 + over[0].length;
      if (segment.text[specificationStart] === "(") {
        const specificationEnd =
          matchingParenthesis(segment.text, specificationStart);
        if (specificationEnd === -1) continue;
        const windowBody = segment.text
          .slice(specificationStart + 1, specificationEnd)
          .trim();
        const order = windowBody.match(
          /\bORDER\s+BY\s+([\s\S]*?)(?:\bROWS\b|\bRANGE\b|\bGROUPS\b|$)/i,
        );
        if (order) addOrderFindings(order[1], match.index);
        else {
          const inherited = windowBody.match(
            /^(?:"([^"]+)"|([\w$]+))(?:\s|$)/,
          );
          if (inherited) {
            addNamedWindowFindings(
              inherited[1] ?? inherited[2],
              match.index,
            );
          }
        }
      } else {
        const inherited = segment.text
          .slice(specificationStart)
          .match(/^(?:"([^"]+)"|([\w$]+))/);
        if (inherited) {
          addNamedWindowFindings(inherited[1] ?? inherited[2], match.index);
        }
      }
    }

    const distinctOn = /\bDISTINCT\s+ON\s*\(/gi;
    for (const match of segment.text.matchAll(distinctOn)) {
      const openingIndex = match.index + match[0].lastIndexOf("(");
      const closingIndex = matchingParenthesis(segment.text, openingIndex);
      if (closingIndex === -1) continue;
      const depth = depthAt(match.index);
      const scopeEnd = scopeEndAt(match.index, depth);
      const winnerOrder = orderClauses.find(
        (order) =>
          order.index > closingIndex &&
          order.index < scopeEnd &&
          depthAt(order.index) === depth,
      );
      if (!winnerOrder) continue;
      const terminators = [...limitClauses, ...fetchClauses, ...offsetClauses]
        .filter(
          (clause) =>
            clause.index > winnerOrder.index &&
            clause.index < scopeEnd &&
            depthAt(clause.index) === depth,
        )
        .sort((left, right) => left.index - right.index);
      const orderEnd = terminators[0]?.index ?? scopeEnd;
      addOrderFindings(
        segment.text.slice(
          winnerOrder.index + winnerOrder[0].length,
          orderEnd,
        ),
        winnerOrder.index,
        true,
      );
    }

    const textExtrema = /\b(?:min|max)\s*\(/gi;
    for (const match of segment.text.matchAll(textExtrema)) {
      const openingIndex = match.index + match[0].lastIndexOf("(");
      const closingIndex = matchingParenthesis(segment.text, openingIndex);
      if (closingIndex === -1) continue;
      const expression = segment.text.slice(openingIndex + 1, closingIndex);
      const { aliases, tables, defaultTable, scopedTypes } =
        environmentAt(match.index);
      if (
        isUnsafeTextExpression(
          expression,
          scopedTypes,
          aliases,
          defaultTable,
          tables,
        )
      ) {
        findings.push({
          line: lineAt(sql, segment.index + match.index),
          expression: expression.trim(),
          reason: "text min/max uses database-default collation",
        });
      }
    }
  }

  return findings;
};