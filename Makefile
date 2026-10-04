.PHONY: install uninstall test-install
PYTHON ?= python3

install:
	$(PYTHON) scripts/install/install.py install

uninstall:
	$(PYTHON) scripts/install/install.py uninstall

test-install:
	$(PYTHON) -m unittest discover -s tests/functional/install -p 'test_*.py'
