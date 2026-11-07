"""The shape of a hand-editable JSON-list settings file (`denylist._apply_json_list`)."""


def check_list_shape(path, data, outer, key):
    """Raise RuntimeError unless `data[outer][key]` (`data[key]` without `outer`) is absent or a
    list inside an object: a file edited by hand into another shape is the person's, and writing
    to it would crash (a string, a number, null) or mangle it (a string becomes its characters)."""
    holder = data
    if outer and outer in data:
        holder = data[outer]
        if not isinstance(holder, dict):
            raise RuntimeError(f"refusing to edit {path}: `{outer}` is not a JSON object; fix it first")
    if key in holder and not isinstance(holder[key], list):
        where = f"{outer}.{key}" if outer else key
        raise RuntimeError(f"refusing to edit {path}: `{where}` is not a JSON list; fix it first")
