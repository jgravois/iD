import * as d3 from 'd3';
import _ from 'lodash';
import { geoExtent, geoPolygonIntersectsPolygon } from '../geo/index';
import { osmNode, osmRelation, osmWay } from '../osm/index';

import { actionAddEntity, actionChangeTags } from '../actions/index';

import { utilDetect } from '../util/detect';
import fromEsri from 'esri-to-geojson';

import polygonArea from 'area-polygon';
import polygonIntersect from 'turf-intersect';
import polygonBuffer from 'turf-buffer';
import pointInside from 'turf-inside';
import { d3combobox } from '../lib/d3.combobox.js';

// dictionary matching geo-properties to OpenStreetMap tags 1:1
window.layerImports = {};

// prevent re-downloading and re-adding the same feature
window.knownObjectIds = {};

// keeping track of added OSM entities
window.importedEntities = [];

export function svgGeoService(projection, context, dispatch) {
    var detected = utilDetect();

    function init() {
        if (svgGeoService.initialized) return;  // run once

        svgGeoService.geojson = {};
        svgGeoService.enabled = true;

        function over() {
            d3.event.stopPropagation();
            d3.event.preventDefault();
            d3.event.dataTransfer.dropEffect = 'copy';
        }
        
        /*
        d3.select('body')
            .attr('dropzone', 'copy')
            .on('drop.localgeoservice', function() {
                d3.event.stopPropagation();
                d3.event.preventDefault();
                if (!detected.filedrop) return;
                drawGeoService.files(d3.event.dataTransfer.files);
            })
            .on('dragenter.localgeoservice', over)
            .on('dragexit.localgeoservice', over)
            .on('dragover.localgeoservice', over);
        */

        svgGeoService.initialized = true;
    }
    
    function drawGeoService(selection) {
        var geojson = svgGeoService.geojson,
            enabled = svgGeoService.enabled,
            gjids = {},
            pointInPolygon = false,
            mergeLines = false;

        try {
            pointInPolygon = d3.selectAll('.point-in-polygon input').property('checked');
        } catch(e) { }
        try {
            mergeLines = d3.selectAll('.merge-lines input').property('checked');
        } catch(e) { }

        function fetchVisibleBuildings(callback, selector) {
            var buildings = d3.selectAll(selector || 'path.tag-building');
            _.map(buildings, function (buildinglist2) {
                _.map(buildinglist2, function (buildinglist) {
                    _.map(buildinglist, function (building) {
                        callback(building);
                    })
                });
            });
        }
        
        function fetchVisibleRoads(callback) {
            return fetchVisibleBuildings(callback, 'path.tag-highway');
        }
        
        function linesMatch(importLine, roadLine) {
            var importPoly = polygonBuffer(importLine, 5, 'meters');
            var roadPoly = polygonBuffer(roadLine, 5, 'meters');
            
            var intersectPoly = polygonIntersect(importPoly, roadPoly);
            if (!intersectPoly) {
                return 0;
            }
            
            function areaFix(polygon) {
                var area = 0;
                if (polygon.geometry.type === 'MultiPolygon') {
                    _.map(polygon.geometry.coordinates, function(section) {
                        area += polygonArea(section[0]);
                    });
                } else {
                    area += polygonArea(polygon.geometry.coordinates[0]);
                }
                return area;
            }
            
            var intersect = areaFix(intersectPoly);
            var overlap1 = intersect / areaFix(importPoly);
            var overlap2 = intersect / areaFix(roadPoly);
            
            // how much of line 1 is in line 2?  how much of line 2 is in line 1?
            // either score could indicate a good fit

            return Math.max(overlap1, overlap2);
        }

        _.map(geojson.features || [], function(d) {
            // don't reload the same objects over again
            if (window.knownObjectIds[d.properties.OBJECTID]) {
                return;
            }
            window.knownObjectIds[d.properties.OBJECTID] = true;
        
            var props, nodes, ln, way, rel;
            function makeEntity(loc_or_nodes) {
                props = {
                    tags: d.properties,
                    visible: true
                };
            
                // don't bring the service's OBJECTID any further
                delete props.tags.OBJECTID;
                
                // allows this helper method to work on nodes and ways
                if (loc_or_nodes.length && (typeof loc_or_nodes[0] === 'string')) {
                    props.nodes = loc_or_nodes;
                } else {
                    props.loc = loc_or_nodes;
                }
                return props;
            }
                
            function makeMiniNodes(pts) {
                // generates the nodes which make up a longer way
                var nodes = [];
                for (var p = 0; p < pts.length; p++) {
                    props = makeEntity(pts[p]);
                    props.tags = {};
                    var node = new osmNode(props);
                    node.approvedForEdit = false;
                    context.perform(
                        actionAddEntity(node),
                        'adding node inside a way'
                    );
                    nodes.push(node.id);
                }
                return nodes;
            }
            
            function mapLine(d, coords) {
                nodes = makeMiniNodes(coords);
                props = makeEntity(nodes);
                way = new osmWay(props, nodes);
                way.approvedForEdit = false;
                context.perform(
                    actionAddEntity(way),
                    'adding way'
                );
                return way;
            }
            
            function mapPolygon(d, coords) {
                d.properties.area = d.properties.area || 'yes';
                if (coords.length > 1) {
                    // donut hole polygons (e.g. building with courtyard) must be a relation
                    // example data: Hartford, CT building footprints
                    // TODO: rings within rings?

                    // generate each ring                    
                    var componentRings = [];
                    for (var ring = 0; ring < coords.length; ring++) {
                        // props.tags = {};
                        way = mapLine(d, coords[ring]);
                        componentRings.push({
                            id: way.id,
                            role: (ring === 0 ? 'outer' : 'inner')
                        });
                    }
                    
                    // generate a relation
                    rel = new osmRelation({
                        tags: {
                            type: 'MultiPolygon'
                        },
                        members: componentRings
                    });
                    rel.approvedForEdit = false;
                    context.perform(
                        actionAddEntity(rel),
                        'adding multiple-ring Polygon'
                    );
                    return rel;
                } else {
                    // polygon with one single ring
                    way = mapLine(d, coords[0]);
                    return way;
                }
            }
                        
            function mergeImportTags(wayid) {
                // merge the active import GeoJSON attributes (d.properties) into item with wayid
                var ent = context.entity(wayid);
                ent.approvedForEdit = false;
                if (!ent.importOriginal) {
                    ent.importOriginal = _.clone(ent.tags);
                }
                
                var originalProperties = _.clone(ent.tags);
                
                var keys = Object.keys(d.properties);
                _.map(keys, function(key) {
                    originalProperties[key] = d.properties[key];
                });

                var adjustedFeature = processGeoFeature({ properties: originalProperties }, gsLayer = context.layers().layer('geoservice').preset());
                
                context.perform(
                    actionChangeTags(wayid, adjustedFeature.properties),
                    'merged import item tags'
                );
                setTimeout(function() {
                    d3.selectAll('.layer-osm .' + wayid).classed('import-edited', true);
                }, 250);
            }
            
            function matchingRoads(importLine) {
                var matches = [];
                fetchVisibleRoads(function(road) {
                    var wayid = d3.select(road).attr('class').split(' ')[3];
                    if (1 * wayid.substring(1) < 0) {
                        // don't apply to new drawn roads
                        return;
                    }
                    var ent;
                        
                    // fetch existing, or load a GeoJSON representation of the road
                    if (!gjids[wayid]) {
                        var nodes = [];
                        ent = context.entity(wayid);
                        _.map(ent.nodes, function(nodeid) {
                            var node = context.entity(nodeid);
                            nodes.push(node.loc);
                        });
                        gjids[wayid] = {
                            type: 'Feature',
                            geometry: {
                                type: 'LineString',
                                coordinates: nodes
                            }
                        };
                    }
                    var isAligned = linesMatch(importLine, gjids[wayid]);
                    if (isAligned > 0.75) {
                        matches.push(wayid);
                        console.log('line match found: ' + wayid + ' (possible segment) val: ' + isAligned);
                        madeMerge = true;
                        mergeImportTags(wayid);
                    }
                });
                return matches;
            }
            
            // importing different GeoJSON geometries
            if (d.geometry.type === 'Point') {
                props = makeEntity(d.geometry.coordinates);
                
                // user is merging points to polygons (example: addresses to buildings)
                if (pointInPolygon) {
                    var matched = false;
                    fetchVisibleBuildings(function(building) {
                        // retrieve GeoJSON for this building if it isn't already stored in gjids { }
                        var wayid = d3.select(building).attr('class').split(' ')[3];
                        var ent;
                        if (!gjids[wayid]) {
                            var nodes = [];
                            ent = context.entity(wayid);
                            _.map(ent.nodes, function(nodeid) {
                                var node = context.entity(nodeid);
                                nodes.push(node.loc);
                            });
                            
                            gjids[wayid] = {
                                type: 'Feature',
                                geometry: {
                                    type: 'Polygon',
                                    coordinates: [nodes]
                                }
                            };
                        }

                        var isInside = pointInside(d, gjids[wayid]);
                        if (isInside) {
                            matched = true;
                            mergeImportTags(wayid);
                        }
                    });
                    
                    if (!matched) {
                        // add address point independently of existing buildings
                        var node = new osmNode(props);
                        node.approvedForEdit = false;
                        context.perform(
                            actionAddEntity(node),
                            'adding point'
                        );
                        window.importedEntities.push(node);
                    }
                    
                } else {
                    var node = new osmNode(props);
                    node.approvedForEdit = false;
                    context.perform(
                        actionAddEntity(node),
                        'adding point'
                    );
                    window.importedEntities.push(node);
                }
                  
            } else if (d.geometry.type === 'LineString') {                
                if (mergeLines) {
                    var mergeRoads = matchingRoads(d);
                    /*
                    _.map(mergeRoads, function(mergeRoadWayId) {    
                    });
                    */
                    
                    if (!mergeRoads.length) {
                        // none of the roads overlapped
                        window.importedEntities.push(mapLine(d, d.geometry.coordinates));
                    }
                } else {
                    window.importedEntities.push(mapLine(d, d.geometry.coordinates));
                }
                    
            } else if (d.geometry.type === 'MultiLineString') {
                var lines = [];
                for (ln = 0; ln < d.geometry.coordinates.length; ln++) {
                    if (mergeLines) {
                        // test each part of the MultiLineString for merge-ability
                        
                        // this fragment of the MultiLineString should be compared
                        var importPart = {
                            type: 'Feature',
                            geometry: {
                                type: 'LineString',
                                coordinates: d.geometry.coordinates[ln]
                            }
                        };
                        var mergeRoads = matchingRoads(importPart);
                        
                        /*
                        _.map(mergeRoads, function(mergeRoadWayId) {
                        
                        });
                        */
                        
                        if (!mergeRoads.length) {
                            // TODO: what if part or all of the MultiLineString does not have a place to merge to?
                        }
                    } else {
                        lines.push({
                            id: mapLine(d, d.geometry.coordinates[ln]).id,
                            role: '' // todo roles: this empty string assumes the lines make up a route
                        });
                    }
                }
                
                // don't add geodata if we are busy merging lines
                if (mergeLines) {
                    return;
                }
                
                // generate a relation
                rel = new osmRelation({
                    tags: {
                        type: 'route' // todo multilinestring and multipolygon types
                    },
                    members: lines
                });
                rel.approvedForEdit = false;
                context.perform(
                    actionAddEntity(rel),
                    'adding multiple Lines as a Relation'
                );
                window.importedEntities.push(rel);
                
                    
            } else if (d.geometry.type === 'Polygon') {
                window.importedEntities.push(mapPolygon(d, d.geometry.coordinates));

            } else if (d.geometry.type === 'MultiPolygon') {
                var polygons = [];
                for (ln = 0; ln < d.geometry.coordinates.length; ln++) {
                    polygons.push({
                        id: mapPolygon(d, d.geometry.coordinates[ln]).id,
                        role: ''
                    });
                }
                
                // generate a relation
                rel = new osmRelation({
                    tags: {
                        type: 'MultiPolygon'
                    },
                    members: polygons
                });
                rel.approvedForEdit = false;
                context.perform(
                    actionAddEntity(rel),
                    'adding multiple Polygons as a Relation'
                );
                window.importedEntities.push(rel);

            } else {
                console.log('Did not recognize Geometry Type: ' + d.geometry.type);
            }
        });
        
        return this;
    }
    
    function processGeoFeature(selectfeature, preset) {
        // when importing an object, accept users' changes to keys
        var convertedKeys = Object.keys(window.layerImports);
        var presetKeysLength = preset || 0;
        
        // keep the OBJECTID to make sure we don't download the same data multiple times
        var outprops = {
            OBJECTID: selectfeature.properties.OBJECTID
        };

        // convert the rest of the layer's properties
        for (var k = 0; k < convertedKeys.length; k++) {
            var osmk = null;
            var osmv = null;

            if (convertedKeys[k].indexOf('add_') === 0) {
                osmk = convertedKeys[k].substring(4);
                osmv = window.layerImports[convertedKeys[k]];
            } else {
                osmv = selectfeature.properties[convertedKeys[k]];
                if (osmv) {
                    osmk = window.layerImports[convertedKeys[k]];
                }
            }
                
            if (osmk) {
                if (convertedKeys.length > presetKeysLength) {
                    // user directs any transferred keys
                    outprops[osmk] = osmv;
                } else {
                    // merge keys
                    selectfeature.properties[osmk] = osmv;
                }
            }
        }
        if (Object.keys(outprops).length > 1) {
            selectfeature.properties = outprops;
        }
        return selectfeature;
    }

    
    drawGeoService.pane = function() {
        if (!this.geoservicepane) {
            this.geoservicepane = d3.selectAll('.geoservice-pane');
        }
        return this.geoservicepane;
    };

    drawGeoService.enabled = function(_) {
        if (!arguments.length) return svgGeoService.enabled;
        svgGeoService.enabled = _;
        dispatch.call('change');
        return this;
    };


    drawGeoService.hasData = function() {
        var geojson = svgGeoService.geojson;
        return (!(_.isEmpty(geojson) || _.isEmpty(geojson.features)));
    };
    
    drawGeoService.windowOpen = function() {
        return !this.pane().classed('hide');
    };
    
    drawGeoService.awaitingUrl = function() {
        return this.windowOpen() && (!this.pane().selectAll('.topurl').classed('hide'));
    };
    
    drawGeoService.preset = function(preset) {
        // get / set an individual preset, or reset to null
        console.log(preset);
        if (preset) {
            // console.log(preset)
            // preset.tags { }
            // preset.fields[{ keys: [], strings: { placeholders: { } } }]
            
            var presetBox = this.pane().selectAll('.preset');
            if (!preset.icon) {
                preset.icon = 'marker-stroked';
            }
            var tag = preset.icon + ' tag-' + preset.id.split('/')[0] + ' tag-' + preset.id.replace('/', '-');
            
            presetBox.selectAll('label.preset-prompt').text('OpenStreetMap preset: ');
            presetBox.selectAll('span.preset-prompt').text(preset.id);
            presetBox.selectAll('.preset-icon-fill')
                .attr('class', 'preset-icon-fill preset-icon-fill-area preset-icon-fill-line' + tag);
            presetBox.selectAll('.preset-icon-fill, .preset-icon')
                .classed('hide', false);
            presetBox.selectAll('.preset svg')
                .attr('class', 'icon ' + tag)
                .html('<use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#' + preset.icon + '"></use><use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#' + preset.icon + '-24"></use>');
            presetBox.selectAll('button').classed('hide', false);
            this.internalPreset = preset;
            
            // special geo circumstances
            if (preset.id === 'address') {
                return d3.selectAll('.point-in-polygon').classed('must-show', true);
            } else if (preset.id.indexOf('cycle') > -1) {
                return d3.selectAll('.merge-lines').classed('must-show', true);
            } else {
                console.log(preset.id);
            }
            
        } else if (preset === null) {
            // removing preset status
            presetBox.selectAll('.preset label.preset-prompt')
                .text('OpenStreetMap preset (select from left)');
            presetBox.selectAll('.preset span.preset-prompt, .preset svg')
                .html('');
            presetBox.selectAll('.preset button, .preset-icon-fill, .preset-icon')
                .classed('hide', true);

            this.internalPreset = null;
        } else {
            return this.internalPreset;
        }
        
        // reset UI for point-in-polygon and merge-lines
        d3.selectAll('.point-in-polygon, .merge-lines')
            .classed('must-show', false)
            .selectAll('input')
                .property('checked', false);
    };

    drawGeoService.geojson = function(gj) {
        if (!arguments.length) return svgGeoService.geojson;
        if (_.isEmpty(gj) || _.isEmpty(gj.features)) return this;
        svgGeoService.geojson = gj;
        dispatch.call('change');
        return this;
    };

    drawGeoService.url = function(true_url, downloadMax) {
        if (!this.originalURL) {
            this.originalURL = true_url;
        }
    
        // add necessary URL parameters to the user's URL
        var url = true_url;
        if (url.indexOf('outSR') === -1) {
            url += '&outSR=4326';
        }
        if (url.indexOf('&f=') === -1) {
            url += '&f=json';
        }
        
        // turn iD Editor bounds into a query
        var bounds = context.map().trimmedExtent().bbox();
        bounds = JSON.stringify({
            xmin: bounds.minX.toFixed(6) * 1,
            ymin: bounds.minY.toFixed(6) * 1,
            xmax: bounds.maxX.toFixed(6) * 1,
            ymax: bounds.maxY.toFixed(6) * 1,
            spatialReference: {
              wkid: 4326
            }
        });
        if (this.lastBounds === bounds && this.lastProps === JSON.stringify(window.layerImports)) {
            // unchanged bounds, unchanged import parameters, so unchanged data
            return this;
        }
        
        // data has changed - make a query
        this.lastBounds = bounds;
        this.lastProps = JSON.stringify(window.layerImports);

        // make a spatial query within the user viewport (unless the user made their own spatial query)       
        if (!downloadMax && (url.indexOf('spatialRel') === -1)) {
            url += '&geometry=' + this.lastBounds;
            url += '&geometryType=esriGeometryEnvelope';
            url += '&spatialRel=esriSpatialRelIntersects';
            url += '&inSR=4326';
        }
                
        var that = this;
        d3.text(url, function(err, data) {
            if (err) {
                console.log('GeoService URL did not load');
                console.error(err);
            } else {
                // convert EsriJSON text to GeoJSON object
                data = JSON.parse(data);
                var jsondl = fromEsri.fromEsri(data);
                
                // warn if went over server's maximum results count
                if (data.exceededTransferLimit) {
                    window.alert('Service returned first ' + data.features.length + ' results (maximum)');
                }

                that.pane().selectAll('h3').text('Set import attributes');
                var geoserviceTable = d3.selectAll('.geoservice-table');
                
                var convertedKeys = Object.keys(window.layerImports);
                
                if (jsondl.features.length) {
                    // make a row for each GeoJSON property
                    // existing name appears as a label
                    // sample data appears as a text input placeholder
                    // adding text over the sample data makes it into an OSM tag
                    var samplefeature = jsondl.features[0];
                    var keys = Object.keys(samplefeature.properties);
                    geoserviceTable.html('<thead class="tag-row"><th>GeoService field</th><th>Sample Value</th><th>OSM tag</th></thead>');
                    
                    
                    // suggested keys
                    var setPreset = that.preset();
                    var fetcher = function(value, cb) {
                        var v = value.toLowerCase();
                        var suggestedTags = [];
                        if (setPreset) {
                            _.map(setPreset.fields, function(field) {
                                 suggestedTags = suggestedTags.concat(_.map(field.keys, function(key) {
                                     return { value: key };
                                 }));
                            });
                        }
                        cb(suggestedTags.filter(function(d) {
                            return d.value.toLowerCase().indexOf(v) >= 0;
                        }));
                    };

                    // iterate through keys, adding a row describing each
                    // user can set a new property name for each row
                    var doKey = function(r) {
                        if (r >= keys.length) {
                            return;
                        }

                        // don't allow user to change how OBJECTID works
                        if (keys[r] === 'OBJECTID') {
                            return doKey(r + 1);
                        }
        
                        var row = geoserviceTable.append('tr');
                        row.append('td').text(keys[r]); // .attr('class', 'key-wrap');
                        row.append('td').text(samplefeature.properties[keys[r]] || '');
                        
                        var suggestedKeys = d3combobox().fetcher(fetcher).minItems(0);
                        var outfield = row.append('td').append('input');
                        outfield.attr('type', 'text')
                            .attr('name', keys[r])
                            .attr('placeholder', (window.layerImports[keys[r]] || ''))
                            .call(suggestedKeys)
                            .on('change', function() {
                                // properties with this.name renamed to this.value
                                window.layerImports[this.name] = this.value;
                            });
                        doKey(r + 1);
                    };
                        
                    doKey(0);
                } else {
                    console.log('no feature to build table from');
                }
                                
                if (convertedKeys.length > 0) {
                    // if any import properties were added, make these mods and reject all other properties
                    _.map(jsondl.features, function(selectfeature) {
                        return processGeoFeature(selectfeature, that.preset());
                    });
                }
                
                // send the modified geo-features to the draw layer
                drawGeoService.geojson(jsondl);
            }
        });

/*        
        // whenever map is moved, start 0.7s timer to re-download data from ArcGIS service
        // unless we are downloading everything we can anyway
        if (!downloadMax) {
            context.map().on('move', function() {
                if (this.timeout) {
                    clearTimeout(this.timeout);
                }
                this.timeout = setTimeout(function() {
                    this.url(true_url, downloadMax);
                }.bind(this), 700);
            }.bind(this));
        }
*/        
        return this;
    };

    drawGeoService.fitZoom = function() {
        // todo: implement
        if (!this.hasData()) return this;
        var geojson = svgGeoService.geojson;

        var map = context.map(),
            viewport = map.trimmedExtent().polygon(),
            coords = _.reduce(geojson.features, function(coords, feature) {
                var c = feature.geometry.coordinates;
                return _.union(coords, feature.geometry.type === 'Point' ? [c] : c);
            }, []);

        if (!geoPolygonIntersectsPolygon(viewport, coords, true)) {
            var extent = geoExtent(d3.geoBounds(geojson));
            map.centerZoom(extent.center(), map.trimmedExtentZoom(extent));
        }

        return this;
    };


    init();
    return drawGeoService;
}