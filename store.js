/*

    store.js

    saving and loading Snap! projects

    written by Jens Mönig
    jens@moenig.org

    Copyright (C) 2016 by Jens Mönig

    This file is part of Snap!.

    Snap! is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as
    published by the Free Software Foundation, either version 3 of
    the License, or (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.


    prerequisites:
    --------------
    needs morphic.js, xml.js, and most of Snap!'s other modules


    hierarchy
    ---------
    the following tree lists all constructors hierarchically,
    indentation indicating inheritance. Refer to this list to get a
    contextual overview:

        XML_Serializer
            SnapSerializer


    credits
    -------
    Nathan Dinsmore contributed to the design and implemented a first
    working version of a complete XMLSerializer. I have taken much of the
    overall design and many of the functions and methods in this file from
    Nathan's fine original prototype.

*/

/*global modules, XML_Element, VariableFrame, StageMorph, SpriteMorph,
WatcherMorph, Point, CustomBlockDefinition, Context, ReporterBlockMorph,
CommandBlockMorph, detect, CustomCommandBlockMorph, CustomReporterBlockMorph,
Color, List, newCanvas, Costume, Sound, Audio, IDE_Morph, ScriptsMorph,
BlockMorph, ArgMorph, InputSlotMorph, TemplateSlotMorph, CommandSlotMorph,
FunctionSlotMorph, MultiArgMorph, ColorSlotMorph, nop, CommentMorph, isNil,
localize, sizeOf, ArgLabelMorph, SVG_Costume, MorphicPreferences,
SyntaxElementMorph, Variable, isSnapObject, console, BooleanSlotMorph,
normalizeCanvas*/

// Global stuff ////////////////////////////////////////////////////////

modules.store = '2016-December-27';


// XML_Serializer ///////////////////////////////////////////////////////
/*
    I am an abstract protype for my heirs.

    I manage object identities and keep track of circular data structures.
    Objects are "touched" and a property named "serializationID" is added
    to each, representing an index integer in the list, starting with 1.
*/

// XML_Serializer instance creation:

function XML_Serializer() {
    this.contents = [];
    this.media = [];
    this.isCollectingMedia = false;
}

// XML_Serializer preferences settings:

XML_Serializer.prototype.idProperty = 'serializationID';
XML_Serializer.prototype.mediaIdProperty = 'serializationMediaID';
XML_Serializer.prototype.mediaDetectionProperty = 'isMedia';
XML_Serializer.prototype.version = 1; // increment on structural change

// XML_Serializer accessing:

XML_Serializer.prototype.serialize = function (object) {
    // public: answer an XML string representing the given object
    var xml;
    this.flush(); // in case an error occurred in an earlier attempt
    this.flushMedia();
    xml = this.store(object);
    this.flush();
    return xml;
};

XML_Serializer.prototype.store = function (object, mediaID) {
    // private - mediaID is optional
    if (isNil(object) || !object.toXML) {
        // unsupported type, to be checked before calling store()
        // when debugging, be sure to throw an error at this point
        return '';
    }
    if (this.isCollectingMedia && object[this.mediaDetectionProperty]) {
        this.addMedia(object, mediaID);
        return this.format(
            '<ref mediaID="@"></ref>',
            object[this.mediaIdProperty]
        );
    }
    if (object[this.idProperty]) {
        return this.format('<ref id="@"></ref>', object[this.idProperty]);
    }
    this.add(object);
    return object.toXML(this, mediaID).replace(
        '~',
        this.format('id="@"', object[this.idProperty])
    );
};

XML_Serializer.prototype.mediaXML = function () {
    // answer a project's collected media module as XML
    var xml = '<media>',
        myself = this;
    this.media.forEach(function (object) {
        var str = object.toXML(myself).replace(
            '~',
            myself.format('mediaID="@"', object[myself.mediaIdProperty])
        );
        xml = xml + str;
    });
    return xml + '</media>';
};

XML_Serializer.prototype.undoQueueXML = function (id) {
    var events = SnapUndo.eventHistory[id] || [];

    return this.format('<undo-queue id="@" undo-count="@">%</undo-queue>',
        id,
        SnapUndo.undoCount[id],
        this.undoEventsXML(events)
    );
};

XML_Serializer.prototype.undoEventsXML = function (events, isReplay) {
    var queue = [],
        event,
        args,
        xml;

    for (var i = events.length; i--;) {
        event = events[i];

        args = [];
        for (var a = event.args.length; a--;) {
            args.unshift(this.getArgumentXML('arg', event.args[a]));
        }
        args = args.join('');

        if (!isReplay) {
            xml = this.format(
                '<event id="@"/>',
                event.id
            );
        } else {
            xml = this.format(
                '<event id="@" type="@" replayType="@" time="@" user="@">%</event>',
                event.id,
                event.type,
                event.replayType || 0,
                event.time,
                event.user,
                args
            );
        }
        queue.unshift(xml);
    }

    return queue.join('');
};

XML_Serializer.prototype.getArgumentXML = function (tag, item) {
    var myself = this,
        xml = item;

    if (item instanceof Object) {
        var keys = Object.keys(item);

        xml = keys.map(function(key) {
            if (item[key] instanceof Array) {
                return item[key].map(function(el) {
                    // prefix index with '_' since xml can't start with a number
                    return myself.getArgumentXML('_' + key, el);
                }).join('');
            } else {
                if (/^[^a-zA-Z].*/.test(key)) {
                    return myself.getArgumentXML('_' + key, item[key]);
                }
                return myself.getArgumentXML(key, item[key]);
            }
        }).join('');

    } else if (typeof item === 'string' && item[0] === '<') {
        xml = '<![CDATA[' + item.replace(/]]>/g, '&ncdata;]>') + ']]>';
    }

    return [
        '<', tag, '>',
        xml,
        '</', tag, '>'
    ].join('');
};

XML_Serializer.prototype.loadEventArg = function (xml) {
    var content,
        child,
        isArrayLike,
        tag,
        largestIndex = -1;

    if (xml.children.length) {
        if (xml.children[0].tag === 'CDATA') {
            return xml.children[0].contents.replace(/&ncdata;]>/g, ']]>');
        }

        content = {};
        isArrayLike = true;

        for (var i = xml.children.length; i--;) {
            child = xml.children[i];
            tag = child.tag[0] === '_' ? child.tag.slice(1) : child.tag;
            if (isNaN(+tag)) {
                isArrayLike = false;
            }
            if (content[tag] instanceof Array) {
                content[tag].unshift(this.loadEventArg(child));
            } else if (content[tag]) {
                content[tag] = [this.loadEventArg(child), content[tag]];
            } else {
                content[tag] = this.loadEventArg(child);
            }
            if (isArrayLike) {
                largestIndex = Math.max(largestIndex, +tag);
            }
        }

        if (isArrayLike) {
            content.length = largestIndex + 1;
            content = Array.prototype.slice.call(content);
        }

        return content;
    } else {
        return xml.contents;
    }
};

XML_Serializer.prototype.historyXML = function (ownerId) {
    var myself = this,
        prefix = ownerId && ownerId + '/',
        queueIds = SnapUndo.allQueueIds().filter(function(queueId) {
            return prefix ? queueId.indexOf(prefix) === 0 :
                queueId.indexOf('/') === -1;
        });

    return queueIds.map(function(id) {
        return myself.undoQueueXML(id);
    }).join('');
};

XML_Serializer.prototype.replayHistory = function () {
    return this.undoEventsXML(SnapUndo.allEvents, true);
};

XML_Serializer.prototype.add = function (object) {
    // private - mark the object with a serializationID property and add it
    if (object[this.idProperty]) { // already present
        return -1;
    }
    this.contents.push(object);
    object[this.idProperty] = this.contents.length;
    return this.contents.length;
};

XML_Serializer.prototype.addMedia = function (object, mediaID) {
    // private - mark the object with a serializationMediaID property
    // and add it to media
    // if a mediaID is given, take it, otherwise generate one
    if (object[this.mediaIdProperty]) { // already present
        return -1;
    }
    this.media.push(object);
    if (mediaID) {
        object[this.mediaIdProperty] = mediaID + '_' + object.name;
    } else {
        object[this.mediaIdProperty] = this.media.length;
    }
    return this.media.length;
};

XML_Serializer.prototype.at = function (integer) {
    // private
    return this.contents[integer - 1];
};

XML_Serializer.prototype.flush = function () {
    // private - free all objects and empty my contents
    var myself = this;
    this.contents.forEach(function (obj) {
        delete obj[myself.idProperty];
    });
    this.contents = [];
};

XML_Serializer.prototype.flushMedia = function () {
    // private - free all media objects and empty my media
    var myself = this;
    if (this.media instanceof Array) {
        this.media.forEach(function (obj) {
            delete obj[myself.mediaIdProperty];
        });
    }
    this.media = [];
};

// XML_Serializer formatting:

XML_Serializer.prototype.escape = XML_Element.prototype.escape;
XML_Serializer.prototype.unescape = XML_Element.prototype.unescape;


XML_Serializer.prototype.format = function (string) {
    // private
    var myself = this,
        i = -1,
        values = arguments,
        value;

    return string.replace(/[@$%]([\d]+)?/g, function (spec, index) {
        index = parseInt(index, 10);

        if (isNaN(index)) {
            i += 1;
            value = values[i + 1];
        } else {
            value = values[index + 1];
        }
        // original line of code - now frowned upon by JSLint:
        // value = values[(isNaN(index) ? (i += 1) : index) + 1];

        return spec === '@' ?
                myself.escape(value)
                    : spec === '$' ?
                        myself.escape(value, true)
                            : value;
    });
};

// XML_Serializer loading:

XML_Serializer.prototype.load = function (xmlString) {
    // public - answer a new object which is represented by the given
    // XML string.
    nop(xmlString);
    throw new Error(
        'loading should be implemented in heir of XML_Serializer'
    );
};

XML_Serializer.prototype.parse = function (xmlString) {
    // private - answer an XML_Element representing the given XML String
    var element = new XML_Element();
    element.parseString(xmlString);
    return element;
};

// SnapSerializer ////////////////////////////////////////////////////////////

var SnapSerializer;

// SnapSerializer inherits from XML_Serializer:

SnapSerializer.prototype = new XML_Serializer();
SnapSerializer.prototype.constructor = SnapSerializer;
SnapSerializer.uber = XML_Serializer.prototype;

// SnapSerializer constants:

SnapSerializer.prototype.app = 'Snap! 4.0, http://snap.berkeley.edu';

SnapSerializer.prototype.thumbnailSize = new Point(160, 120);
SnapSerializer.prototype.isSavingHistory = false;

SnapSerializer.prototype.watcherLabels = {
    xPosition: 'x position',
    yPosition: 'y position',
    direction: 'direction',
    getScale: 'size',
    getTempo: 'tempo',
    getLastAnswer: 'answer',
    getLastMessage: 'message',
    getTimer: 'timer',
    getCostumeIdx: 'costume #',
    reportMouseX: 'mouse x',
    reportMouseY: 'mouse y',
    reportThreadCount: 'processes'
};

// SnapSerializer instance creation:

function SnapSerializer() {
    this.init();
}

// SnapSerializer initialization:

SnapSerializer.prototype.init = function () {
    this.project = {};
    this.objects = {};
    this.mediaDict = {};
    this.isSavingCustomBlockOwners = true;
};

// SnapSerializer saving:

XML_Serializer.prototype.mediaXML = function (name) {
    // under construction....
    var xml = '<media name="' +
            (name || 'untitled') +
            '" app="' + this.app +
            '" version="' +
            this.version +
            '">',
        myself = this;
    this.media.forEach(function (object) {
        var str = object.toXML(myself).replace(
            '~',
            myself.format('mediaID="@"', object[myself.mediaIdProperty])
        );
        xml = xml + str;
    });
    return xml + '</media>';
};

// SnapSerializer loading:

SnapSerializer.prototype.load = function (xmlString, ide) {
    // public - answer a new Project represented by the given XML String
    return this.loadProjectModel(this.parse(xmlString), ide);
};

SnapSerializer.prototype.loadProjectModel = function (xmlNode, ide) {
    // public - answer a new Project represented by the given XML top node
    // show a warning if the origin apps differ

    var appInfo = xmlNode.attributes.app,
        app = appInfo ? appInfo.split(' ')[0] : null;

    if (ide && app && app !== this.app.split(' ')[0]) {
        ide.inform(
            app + ' Project',
            'This project has been created by a different app:\n\n' +
                app +
                '\n\nand may be incompatible or fail to load here.'
        );
    }
    return this.rawLoadProjectModel(xmlNode);
};

SnapSerializer.prototype.rawLoadProjectModel = function (xmlNode) {
    // private
    var myself = this,
        project = {sprites: {}},
        model,
        nameID;

    this.project = project;

    model = {project: xmlNode };
    if (+xmlNode.attributes.version > this.version) {
        throw 'Project uses newer version of Serializer';
    }

    /* Project Info */

    this.objects = {};
    project.name = model.project.attributes.name;
    if (!project.name) {
        nameID = 1;
        while (
            Object.prototype.hasOwnProperty.call(
                localStorage,
                '-snap-project-Untitled ' + nameID
            )
        ) {
            nameID += 1;
        }
        project.name = 'Untitled ' + nameID;
    }
    model.notes = model.project.childNamed('notes');
    if (model.notes) {
        project.notes = model.notes.contents;
    }
    model.globalVariables = model.project.childNamed('variables');
    project.globalVariables = new VariableFrame();
    project.collabStartIndex = +(model.project.attributes.collabStartIndex || 0);
    this.loadReplayHistory(xmlNode.childNamed('replay'));

    /* Stage */

    model.stage = model.project.require('stage');
    StageMorph.prototype.frameRate = 0;
    project.stage = new StageMorph(project.globalVariables);
    if (Object.prototype.hasOwnProperty.call(
            model.stage.attributes,
            'id'
        )) {
        this.objects[model.stage.attributes.id] = project.stage;
    }
    if (model.stage.attributes.name) {
        project.stage.name = model.stage.attributes.name;
    }
    if (model.stage.attributes.scheduled === 'true') {
        project.stage.fps = 30;
        StageMorph.prototype.frameRate = 30;
    }
    model.pentrails = model.stage.childNamed('pentrails');
    if (model.pentrails) {
        project.pentrails = new Image();
        project.pentrails.onload = function () {
            if (project.stage.trailsCanvas) { // work-around a bug in FF
                normalizeCanvas(project.stage.trailsCanvas);
                var context = project.stage.trailsCanvas.getContext('2d');
                context.drawImage(project.pentrails, 0, 0);
                project.stage.changed();
            }
        };
        project.pentrails.src = model.pentrails.contents;
    }
    project.stage.setTempo(model.stage.attributes.tempo);
    StageMorph.prototype.dimensions = new Point(480, 360);
    if (model.stage.attributes.width) {
        StageMorph.prototype.dimensions.x =
            Math.max(+model.stage.attributes.width, 480);
    }
    if (model.stage.attributes.height) {
        StageMorph.prototype.dimensions.y =
            Math.max(+model.stage.attributes.height, 180);
    }
    project.stage.id = model.stage.attributes.collabId || null;
    project.stage.setExtent(StageMorph.prototype.dimensions);
    SpriteMorph.prototype.useFlatLineEnds =
        model.stage.attributes.lines === 'flat';
    project.stage.isThreadSafe =
        model.stage.attributes.threadsafe === 'true';
    StageMorph.prototype.enableCodeMapping =
        model.stage.attributes.codify === 'true';
    StageMorph.prototype.enableInheritance =
        model.stage.attributes.inheritance === 'true';
    StageMorph.prototype.enableSublistIDs =
        model.stage.attributes.sublistIDs === 'true';

    model.hiddenPrimitives = model.project.childNamed('hidden');
    if (model.hiddenPrimitives) {
        model.hiddenPrimitives.contents.split(' ').forEach(
            function (sel) {
                if (sel) {
                    StageMorph.prototype.hiddenPrimitives[sel] = true;
                }
            }
        );
    }

    model.codeHeaders = model.project.childNamed('headers');
    if (model.codeHeaders) {
        model.codeHeaders.children.forEach(function (xml) {
            StageMorph.prototype.codeHeaders[xml.tag] = xml.contents;
        });
    }

    model.codeMappings = model.project.childNamed('code');
    if (model.codeMappings) {
        model.codeMappings.children.forEach(function (xml) {
            StageMorph.prototype.codeMappings[xml.tag] = xml.contents;
        });
    }

    model.globalBlocks = model.project.childNamed('blocks');
    if (model.globalBlocks) {
        this.loadCustomBlocks(project.stage, model.globalBlocks, true);
        this.populateCustomBlocks(
            project.stage,
            model.globalBlocks,
            true
        );
    }
    this.loadObject(project.stage, model.stage);
    this.loadHistory(xmlNode.childNamed('history'));

    /* Sprites */

    model.sprites = model.stage.require('sprites');
    project.sprites[project.stage.name] = project.stage;

    model.sprites.childrenNamed('sprite').forEach(function (model) {
        myself.loadValue(model);
    });


    // restore inheritance and nesting associations
    myself.project.stage.children.forEach(function (sprite) {
        var exemplar, anchor;
        if (sprite.inheritanceInfo) { // only sprites can inherit
            exemplar = myself.project.sprites[
                sprite.inheritanceInfo.exemplar
            ];
            if (exemplar) {
                sprite.setExemplar(exemplar);
            }
        }
        if (sprite.nestingInfo) { // only sprites may have nesting info
            anchor = myself.project.sprites[sprite.nestingInfo.anchor];
            if (anchor) {
                anchor.attachPart(sprite);
            }
            sprite.rotatesWithAnchor = (sprite.nestingInfo.synch === 'true');
        }
    });
    myself.project.stage.children.forEach(function (sprite) {
        delete sprite.inheritanceInfo;
        if (sprite.nestingInfo) { // only sprites may have nesting info
            sprite.nestingScale = +(sprite.nestingInfo.scale || sprite.scale);
            delete sprite.nestingInfo;
        }
    });

    /* Global Variables */

    if (model.globalVariables) {
        this.loadVariables(
            project.globalVariables,
            model.globalVariables
        );
    }

    this.objects = {};

    /* Watchers */

    model.sprites.childrenNamed('watcher').forEach(function (model) {
        var watcher, color, target, hidden, extX, extY;

        color = myself.loadColor(model.attributes.color);
        target = Object.prototype.hasOwnProperty.call(
            model.attributes,
            'scope'
        ) ? project.sprites[model.attributes.scope] : null;

        // determine whether the watcher is hidden, slightly
        // complicated to retain backward compatibility
        // with former tag format: hidden="hidden"
        // now it's: hidden="true"
        hidden = Object.prototype.hasOwnProperty.call(
            model.attributes,
            'hidden'
        ) && (model.attributes.hidden !== 'false');

        if (Object.prototype.hasOwnProperty.call(
                model.attributes,
                'var'
            )) {
            watcher = new WatcherMorph(
                model.attributes['var'],
                color,
                isNil(target) ? project.globalVariables
                    : target.variables,
                model.attributes['var'],
                hidden
            );
        } else {
            watcher = new WatcherMorph(
                localize(myself.watcherLabels[model.attributes.s]),
                color,
                target,
                model.attributes.s,
                hidden
            );
        }
        watcher.setStyle(model.attributes.style || 'normal');
        if (watcher.style === 'slider') {
            watcher.setSliderMin(model.attributes.min || '1', true);
            watcher.setSliderMax(model.attributes.max || '100', true);
        }
        watcher.setPosition(
            project.stage.topLeft().add(new Point(
                +model.attributes.x || 0,
                +model.attributes.y || 0
            ))
        );
        project.stage.add(watcher);
        watcher.onNextStep = function () {this.currentValue = null; };

        // set watcher's contentsMorph's extent if it is showing a list and
        // its monitor dimensions are given
        if (watcher.currentValue instanceof List) {
            extX = model.attributes.extX;
            if (extX) {
                watcher.cellMorph.contentsMorph.setWidth(+extX);
            }
            extY = model.attributes.extY;
            if (extY) {
                watcher.cellMorph.contentsMorph.setHeight(+extY);
            }
            // adjust my contentsMorph's handle position
            watcher.cellMorph.contentsMorph.handle.drawNew();
        }
    });
    this.objects = {};
    return project;
};

SnapSerializer.prototype.loadReplayHistory = function (xml) {
    var queue = xml ? xml.children : [],
        event;

    for (var e = queue.length; e--;) {
        event = this.parseEvent(null, queue[e], true);
        SnapUndo.allEvents.unshift(event);
    }
};

SnapSerializer.prototype.loadHistory = function (model) {
    var queues = model ? model.children : [],
        queue,
        event,
        id,
        rIndex,
        eventId;

    for (var i = queues.length; i--;) {
        id = queues[i].attributes.id;
        rIndex = SnapUndo.allEvents.length - 1;
        SnapUndo.undoCount[id] = +queues[i].attributes['undo-count'] || 0;
        SnapUndo.eventHistory[id] = [];
        queue = queues[i].children;
        for (var e = queue.length; e--;) {
            eventId = +queue[e].attributes.id;
            while (rIndex >= 0 && SnapUndo.allEvents[rIndex].id !== eventId) {
                rIndex--;
            }
            if (rIndex >= 0) {
                event = SnapUndo.allEvents[rIndex];
                event.owner = id;
                SnapUndo.eventHistory[id].unshift(event);
            } else {
                console.error('Could not load historical event from replay:', queue[e]);
            }

        }
    }
};

SnapSerializer.prototype.parseEvent = function (owner, xml) {
    var args = [];

    for (var i = xml.children.length; i--;) {
        // The argument is the children (if there is one) converted to a
        // string or the string contents (like a string id)
        args.unshift(this.loadEventArg(xml.children[i]));
    }

    return {
        id: +xml.attributes.id,
        owner: owner,
        type: xml.attributes.type,
        replayType: +xml.attributes.replayType,
        time: +xml.attributes.time,
        user: xml.attributes.user,
        args: args
    };
};

SnapSerializer.prototype.loadBlocks = function (xmlString, targetStage) {
    // public - answer a new Array of custom block definitions
    // represented by the given XML String
    var stage = new StageMorph(),
        model;

    this.project = {
        stage: stage,
        sprites: {},
        targetStage: targetStage // for secondary custom block def look-up
    };
    model = this.parse(xmlString);
    if (+model.attributes.version > this.version) {
        throw 'Module uses newer version of Serializer';
    }
    this.loadCustomBlocks(stage, model, true);
    this.populateCustomBlocks(
        stage,
        model,
        true
    );
    this.objects = {};
    stage.globalBlocks.forEach(function (def) {
        def.receiver = null;
    });
    this.objects = {};
    this.project = {};
    this.mediaDict = {};
    return stage.globalBlocks;
};

SnapSerializer.prototype.loadSprites = function (xmlString, ide) {
    // public - import a set of sprites represented by xmlString
    // into the current project of the ide
    var model, project, myself = this;

    project = this.project = {
        globalVariables: ide.globalVariables,
        stage: ide.stage,
        sprites: {}
    };
    project.sprites[project.stage.name] = project.stage;

    model = this.parse(xmlString);
    if (+model.attributes.version > this.version) {
        throw 'Module uses newer version of Serializer';
    }
    model.childrenNamed('sprite').forEach(function (model) {
        var sprite  = new SpriteMorph(project.globalVariables);

        if (model.attributes.id) {
            myself.objects[model.attributes.id] = sprite;
        }
        if (model.attributes.name) {
            sprite.name = ide.newSpriteName(model.attributes.name);
            project.sprites[sprite.name] = sprite;
        }
        if (model.attributes.color) {
            sprite.color = myself.loadColor(model.attributes.color);
        }
        if (model.attributes.pen) {
            sprite.penPoint = model.attributes.pen;
        }
        if (model.attributes.collabId) {
            sprite.id = model.attributes.collabId;
        }
        project.stage.add(sprite);
        ide.sprites.add(sprite);
        sprite.scale = parseFloat(model.attributes.scale || '1');
        sprite.rotationStyle = parseFloat(
            model.attributes.rotation || '1'
        );
        sprite.isDraggable = model.attributes.draggable !== 'false';
        sprite.isVisible = model.attributes.hidden !== 'true';
        sprite.heading = parseFloat(model.attributes.heading) || 0;
        sprite.drawNew();
        sprite.gotoXY(+model.attributes.x || 0, +model.attributes.y || 0);
        myself.loadObject(sprite, model);

        SnapActions.loadOwner(sprite);
    });

    // restore inheritance and nesting associations
    project.stage.children.forEach(function (sprite) {
        var exemplar, anchor;
        if (sprite.inheritanceInfo) { // only sprites can inherit
            exemplar = project.sprites[
                sprite.inheritanceInfo.exemplar
            ];
            if (exemplar) {
                sprite.setExemplar(exemplar);
            }
        }
        if (sprite.nestingInfo) { // only sprites may have nesting info
            anchor = project.sprites[sprite.nestingInfo.anchor];
            if (anchor) {
                anchor.attachPart(sprite);
            }
            sprite.rotatesWithAnchor = (sprite.nestingInfo.synch === 'true');
        }
    });
    project.stage.children.forEach(function (sprite) {
        delete sprite.inheritanceInfo;
        if (sprite.nestingInfo) { // only sprites may have nesting info
            sprite.nestingScale = +(sprite.nestingInfo.scale || sprite.scale);
            delete sprite.nestingInfo;
        }
    });

    this.objects = {};
    this.project = {};
    this.mediaDict = {};

//    ide.stage.drawNew();
    ide.createCorral();
    ide.fixLayout();

    return project.stage.children;
};

SnapSerializer.prototype.loadMedia = function (xmlString) {
    // public - load the media represented by xmlString into memory
    // to be referenced by a media-less project later
    return this.loadMediaModel(this.parse(xmlString));
};

SnapSerializer.prototype.loadMediaModel = function (xmlNode) {
    // public - load the media represented by xmlNode into memory
    // to be referenced by a media-less project later
    var myself = this,
        model = xmlNode;
    this.mediaDict = {};
    if (+model.attributes.version > this.version) {
        throw 'Module uses newer version of Serializer';
    }
    model.children.forEach(function (model) {
        myself.loadValue(model);
    });
    return this.mediaDict;
};

SnapSerializer.prototype.loadObject = function (object, model) {
    // private
    var blocks = model.require('blocks');
    this.loadInheritanceInfo(object, model);
    this.loadNestingInfo(object, model);
    this.loadCostumes(object, model);
    this.loadSounds(object, model);
    this.loadCustomBlocks(object, blocks);
    this.populateCustomBlocks(object, blocks);
    this.loadVariables(object.variables, model.require('variables'));
    this.loadScripts(object.scripts, model.require('scripts'));
};

SnapSerializer.prototype.loadInheritanceInfo = function (object, model) {
    // private
    var info = model.childNamed('inherit');
    if (info) {
        object.inheritanceInfo = info.attributes;
    }
};

SnapSerializer.prototype.loadNestingInfo = function (object, model) {
    // private
    var info = model.childNamed('nest');
    if (info) {
        object.nestingInfo = info.attributes;
    }
};

SnapSerializer.prototype.loadCostumes = function (object, model) {
    // private
    var costumes = model.childNamed('costumes'),
        costume;
    if (costumes) {
        object.costumes = this.loadValue(costumes.require('list'));
    }
    if (Object.prototype.hasOwnProperty.call(
            model.attributes,
            'costume'
        )) {
        costume = object.costumes.asArray()[model.attributes.costume - 1];
        if (costume) {
            if (costume.loaded) {
                object.wearCostume(costume);
            } else {
                costume.loaded = function () {
                    object.wearCostume(costume);
                    this.loaded = true;
                };
            }
        }
    }
};

SnapSerializer.prototype.loadSounds = function (object, model) {
    // private
    var sounds = model.childNamed('sounds');
    if (sounds) {
        object.sounds = this.loadValue(sounds.require('list'));
    }
};

SnapSerializer.prototype.loadVariables = function (varFrame, element) {
    // private
    var myself = this;

    element.children.forEach(function (child) {
        var v, value;
        if (child.tag !== 'variable') {
            return;
        }
        value = child.children[0];
        v = new Variable();
        v.isTransient = (child.attributes.transient === 'true');
        v.value = (v.isTransient || !value ) ? 0 : myself.loadValue(value);
        varFrame.vars[child.attributes.name] = v;
    });
};

SnapSerializer.prototype.loadCustomBlock = function (element, isGlobal) {
    var definition = new CustomBlockDefinition(element.attributes.s || ''),
        myself = this,
        inputs,
        vars,
        header,
        code,
        comment,
        i,
        names;

    definition.category = element.attributes.category || 'other';
    definition.type = element.attributes.type || 'command';
    definition.isGlobal = (isGlobal === true);
    definition.id = element.attributes.collabId;
    names = definition.parseSpec(definition.spec).filter(
        function (str) {
            return str.charAt(0) === '%' && str.length > 1;
        }
    ).map(function (str) {
        return str.substr(1);
    });

    definition.names = names;
    inputs = element.childNamed('inputs');
    if (inputs) {
        i = -1;
        inputs.children.forEach(function (child) {
            var options = child.childNamed('options');
            if (child.tag !== 'input') {
                return;
            }
            i += 1;
            definition.declarations[names[i]] = [
                child.attributes.type,
                child.contents,
                options ? options.contents : undefined,
                child.attributes.readonly === 'true'
            ];
        });
    }

    vars = element.childNamed('variables');
    if (vars) {
        definition.variableNames = myself.loadValue(
            vars.require('list')
        ).asArray();
    }

    header = element.childNamed('header');
    if (header) {
        definition.codeHeader = header.contents;
    }

    code = element.childNamed('code');
    if (code) {
        definition.codeMapping = code.contents;
    }

    comment = element.childNamed('comment');
    if (comment) {
        definition.comment = myself.loadComment(comment);
    }
    return definition;
};

SnapSerializer.prototype.loadCustomBlocks = function (
    object,
    element,
    isGlobal
) {
    // private
    var myself = this;
    element.children.forEach(function (child) {
        var definition;
        if (child.tag !== 'block-definition') {
            return;
        }
        definition = myself.loadCustomBlock(child, isGlobal);
        definition.receiver = object;
        if (definition.isGlobal) {
            object.globalBlocks.push(definition);
        } else {
            object.customBlocks.push(definition);
        }
    });
};

SnapSerializer.prototype.populateCustomBlocks = function (
    object,
    element,
    isGlobal
) {
    // private
    var myself = this;
    element.children.forEach(function (child, index) {
        var definition, script, scripts;
        if (child.tag !== 'block-definition') {
            return;
        }
        definition = isGlobal ? object.globalBlocks[index]
                : object.customBlocks[index];
        script = child.childNamed('script');
        if (script) {
            definition.body = new Context(
                null,
                script ? myself.loadScript(script) : null,
                null,
                object
            );
            definition.body.inputs = definition.names.slice(0);
        }
        scripts = child.childNamed('scripts');
        if (scripts) {
            definition.scripts = myself.loadScriptsArray(scripts);
        }

        delete definition.names;
    });
};

SnapSerializer.prototype.loadScripts = function (scripts, model) {
    // private
    var myself = this,
        scale = SyntaxElementMorph.prototype.scale;
    scripts.cachedTexture = IDE_Morph.prototype.scriptsPaneTexture;
    model.children.forEach(function (child) {
        var element;
        if (child.tag === 'script') {
            element = myself.loadScript(child);
            if (!element) {
                return;
            }
            element.setPosition(new Point(
                (+child.attributes.x || 0) * scale,
                (+child.attributes.y || 0) * scale
            ).add(scripts.topLeft()));
            scripts.add(element);
            element.fixBlockColor(null, true); // force zebra coloring
            element.allComments().forEach(function (comment) {
                comment.align(element);
            });
        } else if (child.tag === 'comment') {
            element = myself.loadComment(child);
            if (!element) {
                return;
            }
            element.setPosition(new Point(
                (+child.attributes.x || 0) * scale,
                (+child.attributes.y || 0) * scale
            ).add(scripts.topLeft()));
            scripts.add(element);
        }
    });
};

SnapSerializer.prototype.loadScriptsArray = function (model) {
    // private - answer an array containting the model's scripts
    var myself = this,
        scale = SyntaxElementMorph.prototype.scale,
        scripts = [];
    model.children.forEach(function (child) {
        var element;
        if (child.tag === 'script') {
            element = myself.loadScript(child);
            if (!element) {
                return;
            }
            element.setPosition(new Point(
                (+child.attributes.x || 0) * scale,
                (+child.attributes.y || 0) * scale
            ));
            scripts.push(element);
            element.fixBlockColor(null, true); // force zebra coloring
        } else if (child.tag === 'comment') {
            element = myself.loadComment(child);
            if (!element) {
                return;
            }
            element.setPosition(new Point(
                (+child.attributes.x || 0) * scale,
                (+child.attributes.y || 0) * scale
            ));
            scripts.push(element);
        }
    });
    return scripts;
};

SnapSerializer.prototype.loadScript = function (model) {
    // private
    var topBlock, block, nextBlock,
        myself = this;
    model.children.forEach(function (child) {
        nextBlock = myself.loadBlock(child);
        if (!nextBlock) {
            return;
        }
        if (block) {
            if (block.nextBlock && (nextBlock instanceof CommandBlockMorph)) {
                block.nextBlock(nextBlock);
            } else { // +++
                console.log(
                    'SNAP: expecting a command but getting a reporter:\n' +
                        '  ' + block.blockSpec + '\n' +
                        '  ' + nextBlock.blockSpec
                );
                return topBlock;
            }
        } else {
            topBlock = nextBlock;
        }
        block = nextBlock;
    });
    return topBlock;
};

SnapSerializer.prototype.loadComment = function (model) {
    // private
    var comment = new CommentMorph(model.contents),
        scale = SyntaxElementMorph.prototype.scale;
    comment.isCollapsed = (model.attributes.collapsed === 'true');
    comment.setTextWidth(+model.attributes.w * scale);
    comment.id = model.attributes.collabId;
    return comment;
};

SnapSerializer.prototype.loadBlock = function (model, isReporter) {
    // private
    var block, info, inputs, isGlobal, rm, receiver;
    if (model.tag === 'block') {
        if (Object.prototype.hasOwnProperty.call(
                model.attributes,
                'var'
            )) {
            block = SpriteMorph.prototype.variableBlock(
                model.attributes['var']
            );
            block.id = model.attributes.collabId;
            return block;
        }
        /*
        if (model.attributes.s === 'reportJSFunction' &&
                !Process.prototype.enableJS) {
            if (window.confirm('enable JavaScript?')) {
                Process.prototype.enableJS = true;
            } else {
                throw new Error('JavaScript is not enabled');
            }
        }
        */
        block = SpriteMorph.prototype.blockForSelector(model.attributes.s);
    } else if (model.tag === 'custom-block') {
        isGlobal = model.attributes.scope ? false : true;
        receiver = isGlobal ? this.project.stage
            : this.project.sprites[model.attributes.scope];
        rm = model.childNamed('receiver');
        if (rm && rm.children[0]) {
            receiver = this.loadValue(
                model.childNamed('receiver').children[0]
            );
        }
        if (!receiver) {
            if (!isGlobal) {
                receiver = this.project.stage;
            } else {
                block = this.obsoleteBlock(isReporter);
                block.id = model.attributes.collabId;
                return block;
            }
        }
        if (isGlobal) {
            info = detect(receiver.globalBlocks, function (block) {
                return block.blockSpec() === model.attributes.s;
            });
            if (!info && this.project.targetStage) { // importing block files
                info = detect(
                    this.project.targetStage.globalBlocks,
                    function (block) {
                        return block.blockSpec() === model.attributes.s;
                    }
                );
            }
        } else {
            info = detect(receiver.customBlocks, function (block) {
                return block.blockSpec() === model.attributes.s;
            });
        }
        if (!info) {
            block = this.obsoleteBlock(isReporter);
            block.id = model.attributes.collabId;
            return block;
        }
        block = info.type === 'command' ? new CustomCommandBlockMorph(
            info,
            false
        ) : new CustomReporterBlockMorph(
            info,
            info.type === 'predicate',
            false
        );
    }
    if (block === null) {
        block = this.obsoleteBlock(isReporter);
    }
    block.isDraggable = true;
    block.id = model.attributes.collabId;
    inputs = block.inputs();
    model.children.forEach(function (child, i) {
        if (child.tag === 'variables') {
            this.loadVariables(block.variables, child);
        } else if (child.tag === 'comment') {
            block.comment = this.loadComment(child);
            block.comment.block = block;
        } else if (child.tag === 'receiver') {
            nop(); // ignore
        } else {
            this.loadInput(child, inputs[i], block);
        }
    }, this);
    block.cachedInputs = null;
    return block;
};

SnapSerializer.prototype.obsoleteBlock = function (isReporter) {
    // private
    var block = isReporter ? new ReporterBlockMorph()
            : new CommandBlockMorph();
    block.selector = 'errorObsolete';
    block.color = new Color(200, 0, 20);
    block.setSpec('Obsolete!');
    block.isDraggable = true;
    return block;
};

SnapSerializer.prototype.loadInput = function (model, input, block) {
    // private
    var inp, val, myself = this;
    if (model.tag === 'script') {
        inp = this.loadScript(model);
        if (inp) {
            input.add(inp);
            input.fixLayout();
        }
    } else if (model.tag === 'autolambda' && model.children[0]) {
        inp = this.loadBlock(model.children[0], true);
        if (inp) {
            input.silentReplaceInput(input.children[0], inp);
            input.fixLayout();
        }
    } else if (model.tag === 'list') {
        while (input.inputs().length > 0) {
            input.removeInput();
        }
        model.children.forEach(function (item) {
            input.addInput();
            myself.loadInput(
                item,
                input.children[input.children.length - 2],
                input
            );
        });
        input.fixLayout();
    } else if (model.tag === 'block' || model.tag === 'custom-block') {
        block.silentReplaceInput(input, this.loadBlock(model, true));
    } else if (model.tag === 'color') {
        input.setColor(this.loadColor(model.contents));
    } else {
        val = this.loadValue(model);
        if (!isNil(val) && !isNil(input) && input.setContents) {
            // checking whether "input" is nil should not
            // be necessary, but apparently is after retina support
            // was added.
            input.setContents(this.loadValue(model));
        }
    }
};

SnapSerializer.prototype.loadValue = function (model) {
    // private
    var v, i, lst, items, el, center, image, name, audio, option, bool,
        myself = this;

    function record() {
        if (Object.prototype.hasOwnProperty.call(
                model.attributes,
                'id'
            )) {
            myself.objects[model.attributes.id] = v;
        }
        if (Object.prototype.hasOwnProperty.call(
                model.attributes,
                'mediaID'
            )) {
            myself.mediaDict[model.attributes.mediaID] = v;
        }
    }
    switch (model.tag) {
    case 'ref':
        if (Object.prototype.hasOwnProperty.call(model.attributes, 'id')) {
            return this.objects[model.attributes.id];
        }
        if (Object.prototype.hasOwnProperty.call(
                model.attributes,
                'mediaID'
            )) {
            return this.mediaDict[model.attributes.mediaID];
        }
        if (Object.prototype.hasOwnProperty.call(model.attributes, 'actionID')) {
            return SnapActions.getOwnerFromId(model.attributes.actionID);
        }
        throw new Error('expecting a reference id');
    case 'l':
        option = model.childNamed('option');
        if (option) {
            return [option.contents];
        }
        bool = model.childNamed('bool');
        if (bool) {
            return this.loadValue(bool);
        }
        return model.contents;
    case 'bool':
        return model.contents === 'true';
    case 'list':
        if (model.attributes.hasOwnProperty('linked')) {
            v = new List();
            v.isLinked = true;
            record();
            lst = v;
            items = model.childrenNamed('item');
            items.forEach(function (item, i) {
                var value = item.children[0];
                if (!value) {
                    v.first = 0;
                } else {
                    v.first = myself.loadValue(value);
                }
                var tail = model.childNamed('list') ||
                    model.childNamed('ref');
                if (tail) {
                    v.rest = myself.loadValue(tail);
                } else {
                    if (i < (items.length - 1)) {
                        v.rest = new List();
                        v = v.rest;
                        v.isLinked = true;
                    }
                }
            });
            return lst;
        }
        v = new List();
        record();
        v.contents = model.childrenNamed('item').map(function (item) {
            var value = item.children[0];
            if (!value) {
                return 0;
            }
            return myself.loadValue(value);
        });
        return v;
    case 'sprite':
        v  = new SpriteMorph(myself.project.globalVariables);
        if (model.attributes.id) {
            myself.objects[model.attributes.id] = v;
        }
        if (model.attributes.name) {
            v.name = model.attributes.name;
            myself.project.sprites[model.attributes.name] = v;
        }
        if (model.attributes.idx) {
            v.idx = +model.attributes.idx;
        }
        if (model.attributes.color) {
            v.color = myself.loadColor(model.attributes.color);
        }
        if (model.attributes.pen) {
            v.penPoint = model.attributes.pen;
        }
        if (model.attributes.collabId) {
            v.id = model.attributes.collabId;
        }
        myself.project.stage.add(v);
        v.scale = parseFloat(model.attributes.scale || '1');
        v.rotationStyle = parseFloat(
            model.attributes.rotation || '1'
        );
        v.isDraggable = model.attributes.draggable !== 'false';
        v.isVisible = model.attributes.hidden !== 'true';
        v.heading = parseFloat(model.attributes.heading) || 0;
        v.drawNew();
        v.gotoXY(+model.attributes.x || 0, +model.attributes.y || 0);
        myself.loadObject(v, model);
        myself.loadHistory(model.childNamed('history'));
        return v;
    case 'context':
        v = new Context(null);
        record();
        el = model.childNamed('script');
        if (el) {
            v.expression = this.loadScript(el);
        } else {
            el = model.childNamed('block') ||
                model.childNamed('custom-block');
            if (el) {
                v.expression = this.loadBlock(el);
            } else {
                el = model.childNamed('l');
                if (el) {
                    bool = el.childNamed('bool');
                    if (bool) {
                        v.expression = new BooleanSlotMorph(
                            this.loadValue(bool)
                        );
                    } else {
                        v.expression = new InputSlotMorph(el.contents);
                    }
                }
            }
        }
        if (v.expression instanceof BlockMorph) {
            // bind empty slots to implicit formal parameters
            i = 0;
            v.expression.allEmptySlots().forEach(function (slot) {
                i += 1;
                if (slot instanceof MultiArgMorph) {
                    slot.bindingID = ['arguments'];
                } else {
                    slot.bindingID = i;
                }
            });
            // and remember the number of detected empty slots
            v.emptySlots = i;
        }
        el = model.childNamed('receiver');
        if (el) {
            el = el.childNamed('ref') || el.childNamed('sprite');
            if (el) {
                v.receiver = this.loadValue(el);
            }
        }
        el = model.childNamed('inputs');
        if (el) {
            el.children.forEach(function (item) {
                if (item.tag === 'input') {
                    v.inputs.push(item.contents);
                }
            });
        }
        el = model.childNamed('variables');
        if (el) {
            this.loadVariables(v.variables, el);
        }
        el = model.childNamed('context');
        if (el) {
            v.outerContext = this.loadValue(el);
        }
        if (v.outerContext && v.receiver &&
                !v.outerContext.variables.parentFrame) {
            v.outerContext.variables.parentFrame = v.receiver.variables;
        }
        return v;
    case 'costume':
        center = new Point();
        if (Object.prototype.hasOwnProperty.call(
                model.attributes,
                'center-x'
            )) {
            center.x = parseFloat(model.attributes['center-x']);
        }
        if (Object.prototype.hasOwnProperty.call(
                model.attributes,
                'center-y'
            )) {
            center.y = parseFloat(model.attributes['center-y']);
        }
        if (Object.prototype.hasOwnProperty.call(
                model.attributes,
                'name'
            )) {
            name = model.attributes.name;
        }
        if (Object.prototype.hasOwnProperty.call(
                model.attributes,
                'image'
            )) {
            image = new Image();
            if (model.attributes.image.indexOf('data:image/svg+xml') === 0
                    && !MorphicPreferences.rasterizeSVGs) {
                v = new SVG_Costume(null, name, center);
                image.onload = function () {
                    v.contents = image;
                    v.imageSrc = null;
                    v.version = +new Date();
                    if (typeof v.loaded === 'function') {
                        v.loaded();
                    } else {
                        v.loaded = true;
                    }
                };
            } else {
                v = new Costume(null, name, center);
                image.onload = function () {
                    var canvas = newCanvas(
                            new Point(image.width, image.height),
                            true // nonRetina
                        ),
                        context = canvas.getContext('2d');
                    context.drawImage(image, 0, 0);
                    v.contents = canvas;
                    v.imageSrc = null;
                    v.version = +new Date();
                    if (typeof v.loaded === 'function') {
                        v.loaded();
                    } else {
                        v.loaded = true;
                    }
                };
            }
            image.src = model.attributes.image;
            v.imageSrc = model.attributes.image;
        }
        v.id = model.attributes.collabId;
        record();
        return v;
    case 'sound':
        audio = new Audio();
        audio.src = model.attributes.sound;
        v = new Sound(audio, model.attributes.name);
        if (Object.prototype.hasOwnProperty.call(
                model.attributes,
                'mediaID'
            )) {
            myself.mediaDict[model.attributes.mediaID] = v;
        }
        v.id = model.attributes.collabId;
        return v;
    }
    return undefined;
};

SnapSerializer.prototype.loadColor = function (colorString) {
    // private
    var c = (colorString || '').split(',');
    return new Color(
        parseFloat(c[0]),
        parseFloat(c[1]),
        parseFloat(c[2]),
        parseFloat(c[3])
    );
};

SnapSerializer.prototype.openProject = function (project, ide) {
    var stage = ide.stage,
        sprites = [],
        sprite;
    if (!project || !project.stage) {
        return;
    }
    ide.projectName = project.name;
    ide.projectNotes = project.notes || '';
    if (ide.globalVariables) {
        ide.globalVariables = project.globalVariables;
    }
    if (stage) {
        stage.destroy();
    }
    ide.add(project.stage);
    ide.stage = project.stage;
    sprites = ide.stage.children.filter(function (child) {
        return child instanceof SpriteMorph;
    });
    sprites.sort(function (x, y) {
        return x.idx - y.idx;
    });

    ide.sprites = new List(sprites);
    sprite = sprites[0] || project.stage;

    if (sizeOf(this.mediaDict) > 0) {
        ide.hasChangedMedia = false;
        this.mediaDict = {};
    } else {
        ide.hasChangedMedia = true;
    }
    project.stage.drawNew();
    ide.createCorral();
    ide.selectSprite(sprite);
    ide.fixLayout();

    // force watchers to update
    //project.stage.watchers().forEach(function (watcher) {
    //  watcher.onNextStep = function () {this.currentValue = null;};
    //})

    ide.world().keyboardReceiver = project.stage;

    return project;
};

// SnapSerializer XML-representation of objects:

// Generics

Array.prototype.toXML = function (serializer) {
    return this.reduce(function (xml, item) {
        return xml + serializer.store(item);
    }, '');
};

// Sprites

StageMorph.prototype.toXML = function (serializer) {
    var thumbnail = normalizeCanvas(
            this.thumbnail(SnapSerializer.prototype.thumbnailSize),
            true
        ),
        thumbdata,
        ide = this.parentThatIsA(IDE_Morph);

    // catch cross-origin tainting exception when using SVG costumes
    try {
        thumbdata = thumbnail.toDataURL('image/png');
    } catch (error) {
        thumbdata = null;
    }

    function code(key) {
        var str = '';
        Object.keys(StageMorph.prototype[key]).forEach(
            function (selector) {
                str += (
                    '<' + selector + '>' +
                        XML_Element.prototype.escape(
                            StageMorph.prototype[key][selector]
                        ) +
                        '</' + selector + '>'
                );
            }
        );
        return str;
    }

    this.removeAllClones();
    return serializer.format(
        '<project collabStartIndex="@" name="@" app="@" version="@">' +
            '<notes>$</notes>' +
            '<thumbnail>$</thumbnail>' +
            '<stage name="@" width="@" height="@" collabId="@" ' +
            'costume="@" tempo="@" threadsafe="@" ' +
            'lines="@" ' +
            'codify="@" ' +
            'inheritance="@" ' +
            'sublistIDs="@" ' +
            'scheduled="@" ~>' +
            '<pentrails>$</pentrails>' +
            '<costumes>%</costumes>' +
            '<sounds>%</sounds>' +
            '<variables>%</variables>' +
            '<blocks>%</blocks>' +
            '<scripts>%</scripts><sprites>%</sprites>' +
            '</stage>' +
            '<hidden>$</hidden>' +
            '<headers>%</headers>' +
            '<code>%</code>' +
            '<blocks>%</blocks>' +
            '<variables>%</variables>' +
            '<history>%</history>' +
            '<replay>%</replay>' +
            '</project>',
        SnapActions.lastSeen,
        (ide && ide.projectName) ? ide.projectName : localize('Untitled'),
        serializer.app,
        serializer.version,
        (ide && ide.projectNotes) ? ide.projectNotes : '',
        thumbdata,
        this.name,
        StageMorph.prototype.dimensions.x,
        StageMorph.prototype.dimensions.y,
        this.id,
        this.getCostumeIdx(),
        this.getTempo(),
        this.isThreadSafe,
        SpriteMorph.prototype.useFlatLineEnds ? 'flat' : 'round',
        this.enableCodeMapping,
        this.enableInheritance,
        this.enableSublistIDs,
        StageMorph.prototype.frameRate !== 0,
        normalizeCanvas(this.trailsCanvas, true).toDataURL('image/png'),
        serializer.store(this.costumes, this.name + '_cst'),
        serializer.store(this.sounds, this.name + '_snd'),
        serializer.store(this.variables),
        serializer.store(this.customBlocks),
        serializer.store(this.scripts),
        serializer.store(this.children),
        Object.keys(StageMorph.prototype.hiddenPrimitives).reduce(
                function (a, b) {return a + ' ' + b; },
                ''
            ),
        code('codeHeaders'),
        code('codeMappings'),
        serializer.store(this.globalBlocks),
        (ide && ide.globalVariables) ?
                    serializer.store(ide.globalVariables) : '',
        serializer.isSavingHistory ? serializer.historyXML(this.id) : '',
        serializer.isSavingHistory ? serializer.replayHistory() : ''
    );
};

SpriteMorph.prototype.toXML = function (serializer) {
    var stage = this.parentThatIsA(StageMorph),
        ide = stage ? stage.parentThatIsA(IDE_Morph) : null,
        idx = ide ? ide.sprites.asArray().indexOf(this) + 1 : 0;

    return serializer.format(
        '<sprite name="@" collabId="@" idx="@" x="@" y="@"' +
            ' heading="@"' +
            ' scale="@"' +
            ' rotation="@"' +
            ' draggable="@"' +
            '%' +
            ' costume="@" color="@,@,@" pen="@" ~>' +
            '%' + // inheritance info
            '%' + // nesting info
            '<costumes>%</costumes>' +
            '<sounds>%</sounds>' +
            '<variables>%</variables>' +
            '<blocks>%</blocks>' +
            '<scripts>%</scripts>' +
            '<history>%</history>' +
            '</sprite>',
        this.name,
        this.id,
        idx,
        this.xPosition(),
        this.yPosition(),
        this.heading,
        this.scale,
        this.rotationStyle,
        this.isDraggable,
        this.isVisible ? '' : ' hidden="true"',
        this.getCostumeIdx(),
        this.color.r,
        this.color.g,
        this.color.b,
        this.penPoint,

        // inheritance info
        this.exemplar
            ? '<inherit exemplar="' +
                    this.exemplar.name
                    + '"/>'
            : '',

        // nesting info
        this.anchor
            ? '<nest anchor="' +
                    this.anchor.name +
                    '" synch="'
                    + this.rotatesWithAnchor
                    + (this.scale === this.nestingScale ? '' :
                            '"'
                            + ' scale="'
                            + this.nestingScale)

                    + '"/>'
            : '',

        serializer.store(this.costumes, this.name + '_cst'),
        serializer.store(this.sounds, this.name + '_snd'),
        serializer.store(this.variables),
        !this.customBlocks ?
                    '' : serializer.store(this.customBlocks),
        serializer.store(this.scripts),
        serializer.isSavingHistory ? serializer.historyXML(this.id): ''
    );
};

Costume.prototype[XML_Serializer.prototype.mediaDetectionProperty] = true;

Costume.prototype.toXML = function (serializer) {
    // if serializing before the image is loaded, use the raw source. Otherwise,
    // we will serialize as normal
    var imageData = this.imageSrc;
    if (!imageData) {
        imageData = this instanceof SVG_Costume ? this.contents.src
            : normalizeCanvas(this.contents).toDataURL('image/png');
    }

    return serializer.format(
        '<costume name="@" collabId="@" center-x="@" center-y="@" image="@" ~/>',
        this.name,
        this.id,
        this.rotationCenter.x,
        this.rotationCenter.y,
        imageData
    );
};

Sound.prototype[XML_Serializer.prototype.mediaDetectionProperty] = true;

Sound.prototype.toXML = function (serializer) {
    return serializer.format(
        '<sound collabId="@" name="@" sound="@" ~/>',
        this.id,
        this.name,
        this.toDataURL()
    );
};

VariableFrame.prototype.toXML = function (serializer) {
    var myself = this;
    return Object.keys(this.vars).reduce(function (vars, v) {
        var val = myself.vars[v].value,
            dta;
        if (myself.vars[v].isTransient) {
            dta = serializer.format(
                '<variable name="@" transient="true"/>',
                v)
            ;
        } else if (val === undefined || val === null) {
            dta = serializer.format('<variable name="@"/>', v);
        } else {
            dta = serializer.format(
                '<variable name="@">%</variable>',
                v,
                typeof val === 'object' ?
                        (isSnapObject(val) ? ''
                                : serializer.store(val))
                                : typeof val === 'boolean' ?
                                        serializer.format(
                                            '<bool>$</bool>', val
                                        )
                                        : serializer.format('<l>$</l>', val)
            );
        }
        return vars + dta;
    }, '');
};

// Watchers

WatcherMorph.prototype.toXML = function (serializer) {
    var isVar = this.target instanceof VariableFrame,
        isList = this.currentValue instanceof List,
        color = this.readoutColor,
        position = this.parent ?
                this.topLeft().subtract(this.parent.topLeft())
                : this.topLeft();

    if (this.isTemporary()) {
        // do not save watchers on temporary variables
        return '';
    }
    return serializer.format(
        '<watcher% % style="@"% x="@" y="@" color="@,@,@"%%/>',
        (isVar && this.target.owner) || (!isVar && this.target) ?
                    serializer.format(' scope="@"',
                        isVar ? this.target.owner.name : this.target.name)
                            : '',
        serializer.format(isVar ? 'var="@"' : 's="@"', this.getter),
        this.style,
        isVar && this.style === 'slider' ? serializer.format(
                ' min="@" max="@"',
                this.sliderMorph.start,
                this.sliderMorph.stop
            ) : '',
        position.x,
        position.y,
        color.r,
        color.g,
        color.b,
        !isList ? ''
                : serializer.format(
                ' extX="@" extY="@"',
                this.cellMorph.contentsMorph.width(),
                this.cellMorph.contentsMorph.height()
            ),
        this.isVisible ? '' : ' hidden="true"'
    );
};

// Scripts

ScriptsMorph.prototype.toXML = function (serializer) {
    return this.children.reduce(function (xml, child) {
        if (child instanceof BlockMorph) {
            return xml + child.toScriptXML(serializer, true);
        }
        if (child instanceof CommentMorph && !child.block) { // unattached
            return xml + child.toXML(serializer);
        }
        return xml;
    }, '');
};

BlockMorph.prototype.toXML = BlockMorph.prototype.toScriptXML = function (
    serializer,
    savePosition
) {
    var position,
        xml,
        scale = SyntaxElementMorph.prototype.scale,
        block = this;

    // determine my position
    if (this.parent) {
        position = this.topLeft().subtract(this.parent.topLeft());
    } else {
        position = this.topLeft();
    }

    // save my position to xml
    if (savePosition) {
        xml = serializer.format(
            '<script x="@" y="@">',
            position.x / scale,
            position.y / scale
        );
    } else {
        xml = '<script>';
    }

    // recursively add my next blocks to xml
    do {
        xml += block.toBlockXML(serializer);
        block = block.nextBlock();
    } while (block);
    xml += '</script>';
    return xml;
};

BlockMorph.prototype.toBlockXML = function (serializer) {
    return serializer.format(
        '<block collabId="@" s="@">%%</block>',
        this.id,
        this.selector,
        serializer.store(this.inputs()),
        this.comment ? this.comment.toXML(serializer) : ''
    );
};

ReporterBlockMorph.prototype.toXML = function (serializer) {
    return this.selector === 'reportGetVar' ? serializer.format(
        '<block collabId="@" var="@"/>',
        this.id,
        this.blockSpec
    ) : this.toBlockXML(serializer);
};

ReporterBlockMorph.prototype.toScriptXML = function (
    serializer,
    savePosition
) {
    var position,
        scale = SyntaxElementMorph.prototype.scale;

    // determine my save-position
    if (this.parent) {
        position = this.topLeft().subtract(this.parent.topLeft());
    } else {
        position = this.topLeft();
    }

    if (savePosition) {
        return serializer.format(
            '<script x="@" y="@">%</script>',
            position.x / scale,
            position.y / scale,
            this.toXML(serializer)
        );
    }
    return serializer.format('<script>%</script>', this.toXML(serializer));
};

CustomCommandBlockMorph.prototype.toBlockXML = function (serializer) {
    var scope = this.definition.isGlobal ? undefined
        : this.definition.receiver.name;
    return serializer.format(
        '<custom-block collabId="@" s="@"%>%%%%</custom-block>',
        this.id,
        this.blockSpec,
        this.definition.isGlobal ?
                '' : serializer.format(' scope="@"', scope),
        serializer.store(this.inputs()),
        this.definition.variableNames.length ?
                '<variables>' +
                    this.variables.toXML(serializer) +
                    '</variables>'
                        : '',
        this.comment ? this.comment.toXML(serializer) : '',
        scope && !this.definition.receiver[serializer.idProperty] ?
                '<receiver>' +
                    (serializer.isSavingCustomBlockOwners ?
                    serializer.store(this.definition.receiver) :
                    '<ref actionID="' + this.definition.receiver.id +'"/>') +
                    '</receiver>'
                        : ''
    );
};

CustomReporterBlockMorph.prototype.toBlockXML
    = CustomCommandBlockMorph.prototype.toBlockXML;

CustomBlockDefinition.prototype.toXML = function (serializer) {
    var myself = this;


    function encodeScripts(array) {
        return array.reduce(function (xml, element) {
            if (element instanceof BlockMorph) {
                return xml + element.toScriptXML(serializer, true);
            }
            if (element instanceof CommentMorph && !element.block) {
                return xml + element.toXML(serializer);
            }
            return xml;
        }, '');
    }

    return serializer.format(
        '<block-definition collabId="@" s="@" type="@" category="@">' +
            '%' +
            (this.variableNames.length ? '<variables>%</variables>' : '@') +
            '<header>@</header>' +
            '<code>@</code>' +
            '<inputs>%</inputs>%%' +
            '</block-definition>',
        this.id,
        this.spec,
        this.type,
        this.category || 'other',
        this.comment ? this.comment.toXML(serializer) : '',
        (this.variableNames.length ?
                serializer.store(new List(this.variableNames)) : ''),
        this.codeHeader || '',
        this.codeMapping || '',
        Object.keys(this.declarations).reduce(function (xml, decl) {
                return xml + serializer.format(
                    '<input type="@"$>$%</input>',
                    myself.declarations[decl][0],
                    myself.declarations[decl][3] ?
                            ' readonly="true"' : '',
                    myself.declarations[decl][1],
                    myself.declarations[decl][2] ?
                            '<options>' + myself.declarations[decl][2] +
                                '</options>'
                                : ''
                );
            }, ''),
        this.body ? serializer.store(this.body.expression) : '',
        this.scripts.length > 0 ?
                    '<scripts>' + encodeScripts(this.scripts) + '</scripts>'
                        : ''
    );
};

// Scripts - Inputs

ArgMorph.prototype.toXML = function () {
    return '<l/>'; // empty by default
};

BooleanSlotMorph.prototype.toXML = function () {
    return (typeof this.value === 'boolean') ?
            '<l><bool>' + this.value + '</bool></l>'
                    : '<l/>';

};

InputSlotMorph.prototype.toXML = function (serializer) {
    if (this.constant) {
        return serializer.format(
            '<l><option>$</option></l>',
            this.constant
        );
    }
    return serializer.format('<l>$</l>', this.contents().text);
};

TemplateSlotMorph.prototype.toXML = function (serializer) {
    return serializer.format('<l>$</l>', this.contents());
};

CommandSlotMorph.prototype.toXML = function (serializer) {
    var block = this.children[0];
    if (block instanceof BlockMorph) {
        if (block instanceof ReporterBlockMorph) {
            return serializer.format(
                '<autolambda>%</autolambda>',
                serializer.store(block)
            );
        }
        return serializer.store(block);
    }
    return '<script></script>';
};

FunctionSlotMorph.prototype.toXML = CommandSlotMorph.prototype.toXML;

MultiArgMorph.prototype.toXML = function (serializer) {
    return serializer.format(
        '<list>%</list>',
        serializer.store(this.inputs())
    );
};

ArgLabelMorph.prototype.toXML = function (serializer) {
    return serializer.format(
        '%',
        serializer.store(this.inputs()[0])
    );
};

ColorSlotMorph.prototype.toXML = function (serializer) {
    return serializer.format(
        '<color>$,$,$,$</color>',
        this.color.r,
        this.color.g,
        this.color.b,
        this.color.a
    );
};

// Values

List.prototype.toXML = function (serializer, mediaContext) {
    // mediaContext is an optional name-stub
    // when collecting media into a separate module
    var xml, value, item;
    if (this.isLinked) {
        xml = '<list collabId="' + this.id + '" linked="linked" ~>';
        if (StageMorph.prototype.enableSublistIDs) {
            // recursively nest tails:
            value = this.first;
            if (!isNil(value)) {
                xml += serializer.format(
                    '<item>%</item>',
                    typeof value === 'object' ?
                            (isSnapObject(value) ? ''
                                    : serializer.store(value, mediaContext))
                            : typeof value === 'boolean' ?
                                    serializer.format('<bool>$</bool>', value)
                                    : serializer.format('<l>$</l>', value)
                );
            }
            if (!isNil(this.rest)) {
                xml += serializer.store(this.rest, mediaContext);
            }
            return xml + '</list>';
        }
        // else sequentially serialize tails:
        item = this;
        do {
            value = item.first;
            if (!isNil(value)) {
                xml += serializer.format(
                    '<item>%</item>',
                    typeof value === 'object' ?
                            (isSnapObject(value) ? ''
                                    : serializer.store(value, mediaContext))
                            : typeof value === 'boolean' ?
                                    serializer.format('<bool>$</bool>', value)
                                    : serializer.format('<l>$</l>', value)
                );
            }
            item = item.rest;
        } while (!isNil(item));
        return xml + '</list>';
    }
    // dynamic array:
    return serializer.format(
        '<list collabId="@" ~>%</list>',
        this.id,
        this.contents.reduce(function (xml, item) {
            return xml + serializer.format(
                '<item>%</item>',
                typeof item === 'object' ?
                        (isSnapObject(item) ? ''
                                : serializer.store(item, mediaContext))
                        : typeof item === 'boolean' ?
                                serializer.format('<bool>$</bool>', item)
                                : serializer.format('<l>$</l>', item)
            );
        }, '')
    );
};

Context.prototype.toXML = function (serializer) {
    if (this.isContinuation) { // continuations are transient in Snap!
        return '';
    }
    return serializer.format(
        '<context ~><inputs>%</inputs><variables>%</variables>' +
            '%<receiver>%</receiver>%</context>',
        this.inputs.reduce(
                function (xml, input) {
                    return xml + serializer.format('<input>$</input>', input);
                },
                ''
            ),
        this.variables ? serializer.store(this.variables) : '',
        this.expression ? serializer.store(this.expression) : '',
        this.receiver ? serializer.store(this.receiver) : '',
        this.outerContext ? serializer.store(this.outerContext) : ''
    );
};

// Comments

CommentMorph.prototype.toXML = function (serializer) {
    var position,
        scale = SyntaxElementMorph.prototype.scale;

    if (this.block) { // attached to a block
        return serializer.format(
            '<comment collabId="@" w="@" collapsed="@">%</comment>',
            this.id,
            this.textWidth() / scale,
            this.isCollapsed,
            serializer.escape(this.text())
        );
    }

    // free-floating, determine my save-position
    if (this.parent) {
        position = this.topLeft().subtract(this.parent.topLeft());
    } else {
        position = this.topLeft();
    }
    return serializer.format(
        '<comment collabId="@" x="@" y="@" w="@" collapsed="@">%</comment>',
        this.id,
        position.x / scale,
        position.y / scale,
        this.textWidth() / scale,
        this.isCollapsed,
        serializer.escape(this.text())
    );
};
