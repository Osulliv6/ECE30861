"""Small, dependency-light HTML table semantics helper for the document parser."""

def own_rows(node):
    """Rows that belong to this table, excluding rows of nested tables."""
    return [row for row in node.find_all('tr') if row.find_parent('table') is node]

def table_semantics(node, rows=None):
    """Return (row_count, has_column_header_row, has_row_header_column).

    Nested table rows are excluded from the parent table. Only explicit TH
    markup is considered; text formatting is not a substitute for semantics.
    Pass ``rows`` (from ``own_rows``) to avoid finding them twice.
    """
    if rows is None:
        rows = own_rows(node)
    def cells(row):
        return row.find_all(['th', 'td'], recursive=False)
    def scope(cell):
        return str(cell.get('scope', '')).lower()
    def empty_corner(cell):
        # The top-left cell of a two-way grid is often an empty TD.
        return cell.name == 'td' and not cell.get_text(strip=True) and cell.find('img') is None
    def column_header(row):
        row_cells = cells(row)
        headings = [cell for cell in row_cells if cell.name == 'th']
        if not headings or all(scope(h) in ('row', 'rowgroup') for h in headings):
            return False
        if row.find_parent('thead') is not None or any(scope(h) in ('col', 'colgroup') for h in headings):
            return True
        # A row of only TH cells (one is enough, e.g. a single-column table),
        # optionally preceded by an empty corner cell.
        if len(row_cells) > 1 and empty_corner(row_cells[0]):
            row_cells = row_cells[1:]
        return all(cell.name == 'th' for cell in row_cells)
    header_rows = [row for row in rows if column_header(row)]
    data_rows = [row for row in rows
                 if row not in header_rows and any(c.name == 'td' for c in cells(row))]
    has_header_column = bool(data_rows) and all(
        bool(cells(row)) and cells(row)[0].name == 'th'
        and scope(cells(row)[0]) not in ('col', 'colgroup')
        for row in data_rows
    )
    return len(rows), bool(header_rows), has_header_column
