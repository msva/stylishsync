import re
global xpidata

if item.filename in [
  "changelog.txt",
  ]:
  xpidata = None

if xpidata is not None:
  amo_r = re.compile(r"\s//\s*<(Debug|DevRelease)>(.|\n)+?</\1>", re.S)
  xpidata = amo_r.sub("\n", xpidata)
