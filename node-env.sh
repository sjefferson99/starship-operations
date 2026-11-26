# Puts this repo's own Node (in .node/, not committed) first on the PATH.
# Use from the repo root:  source ./node-env.sh
_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export PATH="$_repo_root/.node/bin:$PATH"
unset _repo_root
node --version
