# The llama.cpp release Vunemi's model engine is built from, in one place:
# build-engine.sh builds it, package.sh puts it into the app.
# b12633 (22 Nov 2026): the first builds with Inkling 2 (llama.cpp PR #32694);
# the stable v1.0.0 predates it.
engine_tag="${VUNEMI_ENGINE_TAG:-b12633}"
engine_commit="${VUNEMI_ENGINE_COMMIT:-9c10c94e16ebc4f3ed7c06264a93bf7e019c3f26}"
